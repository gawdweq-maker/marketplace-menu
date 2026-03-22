const FIREBASE_DB_URL = 'https://mar-73-default-rtdb.europe-west1.firebasedatabase.app';
const GLIST_URL = 'https://gist.githubusercontent.com/revo12/2a9c956f1d3ff3c9af769dc5d532e339/raw/8dd5c3ef679092216bb3b9ddfab2926dc6bd2e85/itemid';
const FAVORITES_STORAGE_KEY = 'marketplace_menu_favorites';

const GROUP_KEY_TO_WIKI_SLUG = {
  food: 'food',
  tool: 'tools',
  fish: 'fish',
  equipment: 'equipment',
  alcohol: 'alcohol',
  ammunition: 'ammunition',
  medical: 'medicine',
  auto_parts: 'auto-parts',
  misc: 'misc',
  consumables: 'consumables',
  facilities: 'infrastructure',
  documents: 'documents',
  books: 'books',
  personals: 'personal-items',
  products: 'products',
  agriculture: 'agriculture',
  drugs: 'ingredients',
  armor: 'armor',
  others: 'misc'
};

const state = {
  activeTab: 'favorites',
  search: '',
  items: [],
  favorites: new Set(loadFavorites()),
  categoryByItemId: {},
  firebaseCatalog: {}
};

const els = {
  tabs: Array.from(document.querySelectorAll('.tab')),
  searchInput: document.getElementById('searchInput'),
  refreshButton: document.getElementById('refreshButton'),
  statusBar: document.getElementById('statusBar'),
  favoritesView: document.getElementById('favoritesView'),
  libraryView: document.getElementById('libraryView'),
  favoritesGrid: document.getElementById('favoritesGrid'),
  libraryGrid: document.getElementById('libraryGrid'),
  favoritesEmpty: document.getElementById('favoritesEmpty'),
  libraryEmpty: document.getElementById('libraryEmpty')
};

init();

async function init() {
  bindEvents();
  await loadAllData();
  render();
  resolveMissingNamesInBackground();
}

function bindEvents() {
  els.tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;
      updateTabs();
      render();
    });
  });

  if (els.searchInput) {
    els.searchInput.addEventListener('input', (e) => {
      state.search = e.target.value.trim().toLowerCase();
      render();
    });
  }

  if (els.refreshButton) {
    els.refreshButton.addEventListener('click', async () => {
      await loadAllData();
      render();
      resolveMissingNamesInBackground();
    });
  }
}

function buildDbUrl(path) {
  const cleanPath = String(path || '').replace(/^\/+|\/+$/g, '');
  return cleanPath
    ? `${FIREBASE_DB_URL}/${cleanPath}.json`
    : `${FIREBASE_DB_URL}/.json`;
}

async function loadAllData() {
  setStatus('Загрузка glist...');
  const glist = await loadGlist();

  setStatus('Загрузка данных Firebase...');
  state.firebaseCatalog = await loadFirebaseCatalog();

  state.items = mergeCatalog(glist, state.firebaseCatalog);
  setStatus(`Загружено предметов: ${state.items.length}`);
}

async function loadGlist() {
  const response = await fetch(GLIST_URL);
  if (!response.ok) {
    throw new Error(`glist HTTP ${response.status}`);
  }

  const raw = await response.json();
  return normalizeGlist(raw);
}

async function loadFirebaseCatalog() {
  try {
    const response = await fetch(buildDbUrl('catalog'));
    if (!response.ok) return {};
    const raw = await response.json();
    return raw || {};
  } catch (error) {
    console.warn('Firebase catalog unavailable:', error);
    return {};
  }
}

function normalizeGlist(raw) {
  const result = new Map();
  const categoryByItemId = {};

  Object.keys(raw || {}).forEach((groupName) => {
    const ids = Array.isArray(raw[groupName]) ? raw[groupName] : [];

    ids.forEach((itemId) => {
      const id = Number(itemId);
      if (Number.isNaN(id)) return;

      categoryByItemId[id] = groupName;

      if (!result.has(id)) {
        result.set(id, {
          itemId: id,
          name: '',
          price: 1,
          image: buildDefaultImage(id),
          updatedAt: 0
        });
      }
    });
  });

  state.categoryByItemId = categoryByItemId;
  return Array.from(result.values()).sort((a, b) => a.itemId - b.itemId);
}

function mergeCatalog(baseItems, firebaseCatalog) {
  const map = new Map();

  baseItems.forEach((item) => {
    map.set(item.itemId, { ...item });
  });

  Object.keys(firebaseCatalog || {}).forEach((key) => {
    const row = firebaseCatalog[key] || {};
    const itemId = Number(row.itemId ?? key);
    if (Number.isNaN(itemId)) return;

    const existing = map.get(itemId) || {
      itemId,
      name: '',
      price: 1,
      image: buildDefaultImage(itemId),
      updatedAt: 0
    };

    map.set(itemId, {
      itemId,
      name: row.name ? String(row.name) : existing.name,
      price: normalizePrice(row.price, existing.price),
      image: row.image || existing.image,
      updatedAt: Number(row.updatedAt || existing.updatedAt || 0)
    });
  });

  return Array.from(map.values()).sort((a, b) => a.itemId - b.itemId);
}

async function resolveMissingNamesInBackground() {
  const missing = state.items.filter((item) => !item.name || item.name.trim() === '');
  if (!missing.length) {
    setStatus(`Загружено предметов: ${state.items.length}`);
    return;
  }

  setStatus(`Подтягиваю названия: 0/${missing.length}`);

  for (let i = 0; i < missing.length; i++) {
    const item = missing[i];

    try {
      const categoryKey = state.categoryByItemId[item.itemId] || 'misc';
      const wikiSlug = GROUP_KEY_TO_WIKI_SLUG[categoryKey] || 'misc';
      const wikiUrl = `https://wiki.majestic-rp.ru/ru/items/${wikiSlug}/${item.itemId}`;

      const name = await fetchWikiItemName(wikiUrl);
      if (name) {
        item.name = name;
        await saveNameToFirebase(item.itemId, name, item.image);
      } else {
        item.name = `Предмет #${item.itemId}`;
      }
    } catch (error) {
      console.warn('Failed to resolve item name:', item.itemId, error);
      item.name = item.name || `Предмет #${item.itemId}`;
    }

    if (i % 8 === 0 || i === missing.length - 1) {
      setStatus(`Подтягиваю названия: ${i + 1}/${missing.length}`);
      render();
    }
  }

  setStatus(`Загружено предметов: ${state.items.length}`);
  render();
}

async function fetchWikiItemName(wikiUrl) {
  const response = await fetch(wikiUrl);
  if (!response.ok) {
    throw new Error(`wiki HTTP ${response.status}`);
  }

  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const h1 = doc.querySelector('h1');
  if (h1) {
    const value = normalizeText(h1.textContent);
    if (value) return value;
  }

  const title = doc.querySelector('title');
  if (title) {
    const raw = normalizeText(title.textContent);
    const cleaned = raw
      .replace(/ · Предмет GTA5 RP · Majestic Вики$/i, '')
      .replace(/ \| .*$/i, '')
      .trim();

    if (cleaned) return cleaned;
  }

  return null;
}

async function saveNameToFirebase(itemId, name, image) {
  try {
    await fetch(buildDbUrl(`catalog/${itemId}`), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        itemId,
        name,
        price: 1,
        image: image || buildDefaultImage(itemId),
        updatedAt: Date.now()
      })
    });
  } catch (error) {
    console.warn('Failed to save item name to Firebase:', itemId, error);
  }
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00A0/g, ' ')
    .trim();
}

function normalizePrice(price, fallback = 1) {
  if (price === '' || price === null || price === undefined) {
    return fallback;
  }

  const num = Number(price);
  return Number.isNaN(num) ? fallback : num;
}

function buildDefaultImage(itemId) {
  return `https://cdn-eu.majestic-files.net/public/master/static/img/inventory/items/${itemId}.webp`;
}

function setStatus(text) {
  if (els.statusBar) {
    els.statusBar.textContent = text;
  }
}

function updateTabs() {
  els.tabs.forEach((tab) => {
    tab.classList.toggle('tab--active', tab.dataset.tab === state.activeTab);
  });

  if (els.favoritesView) {
    els.favoritesView.classList.toggle('view--active', state.activeTab === 'favorites');
  }

  if (els.libraryView) {
    els.libraryView.classList.toggle('view--active', state.activeTab === 'library');
  }
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFavorites() {
  localStorage.setItem(
    FAVORITES_STORAGE_KEY,
    JSON.stringify(Array.from(state.favorites))
  );
}

function toggleFavorite(itemId) {
  if (state.favorites.has(itemId)) {
    state.favorites.delete(itemId);
  } else {
    state.favorites.add(itemId);
  }

  saveFavorites();
  render();
}

function getFilteredItems() {
  const searchValue = state.search || '';

  const bySearch = state.items.filter((item) => {
    const itemName = (item.name || '').toLowerCase();
    const searchByName = itemName.includes(searchValue);
    const searchById = String(item.itemId).includes(searchValue);
    return searchByName || searchById;
  });

  if (state.activeTab === 'favorites') {
    return bySearch.filter((item) => state.favorites.has(item.itemId));
  }

  return bySearch;
}

function render() {
  updateTabs();

  const items = getFilteredItems();

  if (state.activeTab === 'favorites') {
    renderGrid(els.favoritesGrid, items);
    if (els.favoritesEmpty) {
      els.favoritesEmpty.style.display = items.length ? 'none' : 'block';
    }
  } else {
    renderGrid(els.libraryGrid, items);
    if (els.libraryEmpty) {
      els.libraryEmpty.style.display = items.length ? 'none' : 'block';
    }
  }
}

function renderGrid(container, items) {
  if (!container) return;

  container.innerHTML = items.map((item) => {
    const active = state.favorites.has(item.itemId);

    return `
      <div class="item-card">
        <div class="item-card__price">${escapeHtml(formatPrice(item.price))}</div>

        <button
          class="item-card__favorite ${active ? 'item-card__favorite--active' : ''}"
          data-favorite-id="${item.itemId}"
          title="Добавить в избраное"
        >★</button>

        <div class="item-card__image-wrap">
          <img
            class="item-card__image"
            src="${escapeHtml(item.image)}"
            alt="${escapeHtml(item.name || ('Предмет #' + item.itemId))}"
            loading="lazy"
          />
        </div>

        <div class="item-card__body">
          <div class="item-card__name">${escapeHtml(item.name || ('Предмет #' + item.itemId))}</div>
          <div class="item-card__id">ID: ${escapeHtml(item.itemId)}</div>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-favorite-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const itemId = Number(button.dataset.favoriteId);
      toggleFavorite(itemId);
    });
  });
}

function formatPrice(price) {
  const num = Number(price);
  if (Number.isNaN(num)) return '1$';
  return `${num.toLocaleString('ru-RU')}$`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
