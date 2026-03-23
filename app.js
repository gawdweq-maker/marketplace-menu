const FIREBASE_DB_URL = 'https://mar-73-default-rtdb.europe-west1.firebasedatabase.app';
const GLIST_URL = 'https://gist.githubusercontent.com/revo12/2a9c956f1d3ff3c9af769dc5d532e339/raw/8dd5c3ef679092216bb3b9ddfab2926dc6bd2e85/itemid';
const FAVORITES_STORAGE_KEY = 'marketplace_menu_favorites';

const GROUP_KEY_TO_WIKI_SLUGS = {
  food: ['food'],
  tool: ['tools', 'tool'],
  fish: ['fish'],
  equipment: ['equipment'],
  alcohol: ['alcohol'],
  ammunition: ['ammunition'],
  medical: ['medicine', 'medical'],
  auto_parts: ['auto-parts', 'auto_parts'],
  misc: ['misc'],
  consumables: ['consumables'],
  facilities: ['facilities', 'infrastructure'],
  documents: ['documents'],
  books: ['books'],
  personals: ['personal-items', 'personals'],
  products: ['products'],
  agriculture: ['agriculture'],
  drugs: ['ingredients', 'drugs'],
  armor: ['armor'],
  others: ['others', 'misc']
};

const state = {
  activeTab: 'favorites',
  search: '',
  items: [],
  favorites: new Set(loadFavorites()),
  categoryByItemId: {},
  parseRunning: false
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
  await reloadAll();
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
      await reloadAll();
    });
  }
}

async function reloadAll() {
  setStatus('Загрузка glist...');
  const glistItems = await loadGlistItems();

  setStatus('Чтение Firebase...');
  const firebaseCatalog = await loadFirebaseCatalog();

  state.items = mergeItems(glistItems, firebaseCatalog);

  render();
  setStatus(`Список загружен. Предметов: ${state.items.length}`);

  await parseMissingNames();
}

function buildDbUrl(path) {
  const cleanPath = String(path || '').replace(/^\/+|\/+$/g, '');
  return cleanPath
    ? `${FIREBASE_DB_URL}/${cleanPath}.json`
    : `${FIREBASE_DB_URL}/.json`;
}

async function loadGlistItems() {
  const response = await fetch(GLIST_URL);
  if (!response.ok) {
    throw new Error(`glist HTTP ${response.status}`);
  }

  const raw = await response.json();
  const map = new Map();
  const categoryByItemId = {};

  Object.keys(raw || {}).forEach((groupName) => {
    const ids = Array.isArray(raw[groupName]) ? raw[groupName] : [];

    ids.forEach((itemId) => {
      const id = Number(itemId);
      if (Number.isNaN(id)) return;

      categoryByItemId[id] = groupName;

      if (!map.has(id)) {
        map.set(id, {
          itemId: id,
          category: groupName,
          name: '',
          price: 1,
          image: buildDefaultImage(id),
          updatedAt: 0
        });
      }
    });
  });

  state.categoryByItemId = categoryByItemId;
  return Array.from(map.values()).sort((a, b) => a.itemId - b.itemId);
}

async function loadFirebaseCatalog() {
  try {
    const response = await fetch(buildDbUrl('catalog'));
    if (!response.ok) return {};
    const raw = await response.json();
    return raw || {};
  } catch (error) {
    console.warn('[firebase-read-fail]', error);
    return {};
  }
}

function mergeItems(glistItems, firebaseCatalog) {
  const map = new Map();

  glistItems.forEach((item) => {
    map.set(item.itemId, { ...item });
  });

  Object.keys(firebaseCatalog || {}).forEach((key) => {
    const row = firebaseCatalog[key] || {};
    const itemId = Number(row.itemId ?? key);
    if (Number.isNaN(itemId)) return;

    const existing = map.get(itemId) || {
      itemId,
      category: row.category || state.categoryByItemId[itemId] || 'misc',
      name: '',
      price: 1,
      image: buildDefaultImage(itemId),
      updatedAt: 0
    };

    map.set(itemId, {
      itemId,
      category: row.category || existing.category,
      name: row.name ? String(row.name) : existing.name,
      price: normalizePrice(row.price, existing.price),
      image: existing.image,
      updatedAt: Number(row.updatedAt || existing.updatedAt || 0)
    });
  });

  return Array.from(map.values()).sort((a, b) => a.itemId - b.itemId);
}

async function parseMissingNames() {
  if (state.parseRunning) return;
  state.parseRunning = true;

  try {
    const queue = state.items.filter((item) => !item.name || !item.name.trim());

    if (!queue.length) {
      setStatus(`Firebase заполнен. Предметов: ${state.items.length}`);
      return;
    }

    let success = 0;
    let fail = 0;
    let writeFail = 0;
    let batch = [];

    setStatus(`Начинаю парсинг: ${queue.length} предметов`);

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];

      try {
        const resolvedName = await resolveNameForItem(item);

        if (resolvedName) {
          item.name = resolvedName;
          item.price = normalizePrice(item.price, 1);
          item.updatedAt = Date.now();

          batch.push(makeFirebasePayload(item));
          success++;

          if (batch.length >= 20) {
            try {
              await saveBatchToFirebase(batch);
              batch = [];
            } catch (e) {
              console.warn('[firebase-batch-fail]', e);
              writeFail += batch.length;
              batch = [];
            }
          }
        } else {
          fail++;
        }
      } catch (error) {
        console.warn('[resolve-error]', item.itemId, error);
        fail++;
      }

      if ((i + 1) % 5 === 0 || i === queue.length - 1) {
        setStatus(
          `Парсинг: ${i + 1}/${queue.length} | найдено: ${success} | без имени: ${fail} | ошибки записи: ${writeFail}`
        );
        render();
      }

      await delay(60);
    }

    if (batch.length) {
      try {
        await saveBatchToFirebase(batch);
      } catch (e) {
        console.warn('[firebase-final-batch-fail]', e);
        writeFail += batch.length;
      }
    }

    setStatus(
      `Готово. Найдено: ${success}, без имени: ${fail}, ошибки записи: ${writeFail}, всего: ${state.items.length}`
    );
    render();
  } finally {
    state.parseRunning = false;
  }
}

function makeFirebasePayload(item) {
  return {
    itemId: item.itemId,
    category: item.category,
    name: item.name,
    price: normalizePrice(item.price, 1),
    updatedAt: Date.now()
  };
}

async function saveBatchToFirebase(items) {
  const payload = {};

  for (const item of items) {
    payload[item.itemId] = item;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(buildDbUrl('catalog'), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`firebase batch PATCH HTTP ${response.status}`);
      }

      const result = await response.json();
      console.log('[firebase-batch-success]', Object.keys(payload).length, result);
      return result;
    } catch (error) {
      lastError = error;
      console.warn('[firebase-batch-retry]', attempt, error.message);
      await delay(400 * attempt);
    }
  }

  throw lastError;
}

async function resolveNameForItem(item) {
  const categoryKey = item.category || state.categoryByItemId[item.itemId] || 'misc';
  const slugCandidates = GROUP_KEY_TO_WIKI_SLUGS[categoryKey] || ['misc'];

  for (const slug of slugCandidates) {
    for (const lang of ['ru', 'en']) {
      const url = `https://wiki.majestic-rp.ru/${lang}/items/${slug}/${item.itemId}`;

      try {
        const name = await fetchNameFromItemPage(url);

        if (name) {
          item.category = categoryKey;
          return name;
        }
      } catch (error) {
        // пробуем следующий URL
      }
    }
  }

  return '';
}

async function fetchNameFromItemPage(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const exactH1 = doc.querySelector('h1.yRrGW6a3');
  if (exactH1) {
    const value = normalizeText(exactH1.textContent);
    if (value) return value;
  }

  const anyH1 = doc.querySelector('h1');
  if (anyH1) {
    const value = normalizeText(anyH1.textContent);
    if (value) return value;
  }

  const title = doc.querySelector('title');
  if (title) {
    const value = normalizeText(title.textContent)
      .replace(/ · Предмет GTA5 RP · Majestic Вики$/i, '')
      .replace(/ \| .*$/i, '')
      .trim();

    if (value) return value;
  }

  return '';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function buildPlaceholderImage(itemId) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
      <rect width="100%" height="100%" rx="12" ry="12" fill="#1d2430"/>
      <text x="50%" y="48%" text-anchor="middle" dominant-baseline="middle" fill="#8fa3c7" font-family="Arial" font-size="13">Нет фото</text>
      <text x="50%" y="68%" text-anchor="middle" dominant-baseline="middle" fill="#6e7f9f" font-family="Arial" font-size="12">#${itemId}</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
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
    return itemName.includes(searchValue) || String(item.itemId).includes(searchValue);
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
    const itemName = item.name || `Предмет #${item.itemId}`;
    const fallbackImage = buildPlaceholderImage(item.itemId);

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
            alt="${escapeHtml(itemName)}"
            loading="lazy"
            onerror="this.onerror=null;this.src='${escapeHtml(fallbackImage)}';"
          />
        </div>

        <div class="item-card__body">
          <div class="item-card__name">${escapeHtml(itemName)}</div>
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
