const FIREBASE_DB_URL = 'https://mar-7-default-rtdb.europe-west1.firebasedatabase.app';
const FAVORITES_STORAGE_KEY = 'marketplace_menu_favorites';

const state = {
  activeTab: 'favorites',
  search: '',
  items: [],
  favorites: new Set(loadFavorites())
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
  await loadCatalog();
  render();
}

function bindEvents() {
  els.tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;
      updateTabs();
      render();
    });
  });

  els.searchInput.addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    render();
  });

  els.refreshButton.addEventListener('click', async () => {
    await loadCatalog();
    render();
  });
}

function buildDbUrl(path) {
  const cleanPath = String(path || '').replace(/^\/+|\/+$/g, '');
  return cleanPath
    ? `${FIREBASE_DB_URL}/${cleanPath}.json`
    : `${FIREBASE_DB_URL}/.json`;
}

async function loadCatalog() {
  setStatus('Загрузка каталога...');

  try {
    const response = await fetch(buildDbUrl('catalog'));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const raw = await response.json();
    state.items = normalizeCatalog(raw);
    setStatus(`Загружено предметов: ${state.items.length}`);
  } catch (error) {
    console.error('Failed to load catalog:', error);
    state.items = [];
    setStatus(`Ошибка загрузки каталога: ${error.message}`);
  }
}

function normalizeCatalog(raw) {
  if (!raw || typeof raw !== 'object') return [];

  return Object.keys(raw)
    .map((key) => {
      const item = raw[key] || {};
      const itemId = Number(item.itemId ?? key);
      const name = item.name ? String(item.name) : `Item ${itemId}`;
      const price = item.price ?? '';
      const image = item.image || buildDefaultImage(itemId);
      const updatedAt = item.updatedAt ?? 0;

      return {
        itemId,
        name,
        price,
        image,
        updatedAt
      };
    })
    .filter((item) => !Number.isNaN(item.itemId))
    .sort((a, b) => a.itemId - b.itemId);
}

function buildDefaultImage(itemId) {
  return `https://cdn-eu.majestic-files.net/public/master/static/img/inventory/items/${itemId}.webp`;
}

function setStatus(text) {
  els.statusBar.textContent = text;
}

function updateTabs() {
  els.tabs.forEach((tab) => {
    tab.classList.toggle('tab--active', tab.dataset.tab === state.activeTab);
  });

  els.favoritesView.classList.toggle('view--active', state.activeTab === 'favorites');
  els.libraryView.classList.toggle('view--active', state.activeTab === 'library');
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
  const bySearch = state.items.filter((item) => {
    const searchByName = item.name.toLowerCase().includes(state.search);
    const searchById = String(item.itemId).includes(state.search);
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
    els.favoritesEmpty.style.display = items.length ? 'none' : 'block';
  } else {
    renderGrid(els.libraryGrid, items);
    els.libraryEmpty.style.display = items.length ? 'none' : 'block';
  }
}

function renderGrid(container, items) {
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
            alt="${escapeHtml(item.name)}"
            loading="lazy"
          />
        </div>

        <div class="item-card__body">
          <div class="item-card__name">${escapeHtml(item.name)}</div>
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
  if (price === '' || price === null || price === undefined) return '';

  const num = Number(price);
  if (Number.isNaN(num)) return String(price);

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
