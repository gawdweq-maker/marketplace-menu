import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://juqibbkgfcefroggwbjb.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_gOmRcvLoj3VBaraUnRcBhw_frmRiGl6';

const GLIST_URL = 'https://gist.githubusercontent.com/revo12/2a9c956f1d3ff3c9af769dc5d532e339/raw/8dd5c3ef679092216bb3b9ddfab2926dc6bd2e85/itemid';
const FAVORITES_STORAGE_KEY = 'marketplace_menu_favorites';
const FUNCTION_NAME = 'rapid-function';

const READ_BATCH_SIZE = 50;
const PARSE_CONCURRENCY = 3;

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const state = {
  activeTab: 'favorites',
  activeCategory: 'all',
  sortMode: 'cheap',
  search: '',
  items: [],
  itemsMap: new Map(),
  favorites: new Set(loadFavorites()),
  parseRunning: false,
  categoryByItemId: {},
  categoryOrder: [],
  selectedItemId: null,
  lotsByItemId: new Map(),
  stats: {
    total: 0,
    processed: 0,
    fromDb: 0,
    parsed: 0,
    saved: 0,
    errors: 0
  }
};

const els = {
  tabs: Array.from(document.querySelectorAll('.tab')),
  searchInput: document.getElementById('searchInput'),
  refreshButton: document.getElementById('refreshButton'),
  sortMenuButton: document.getElementById('sortMenuButton'),
  statusBar: document.getElementById('statusBar'),
  favoritesView: document.getElementById('favoritesView'),
  itemsView: document.getElementById('itemsView'),
  favoritesGrid: document.getElementById('favoritesGrid'),
  itemsGrid: document.getElementById('itemsGrid'),
  favoritesEmpty: document.getElementById('favoritesEmpty'),
  itemsEmpty: document.getElementById('itemsEmpty'),
  itemsSubtabs: document.getElementById('itemsSubtabs'),
  sortPopover: document.getElementById('sortPopover'),
  sortOptions: Array.from(document.querySelectorAll('.sort-option')),
  detailsDrawer: document.getElementById('detailsDrawer'),
  closeDrawerButton: document.getElementById('closeDrawerButton'),
  drawerTitle: document.getElementById('drawerTitle'),
  drawerSubtitle: document.getElementById('drawerSubtitle'),
  drawerImage: document.getElementById('drawerImage'),
  drawerDescription: document.getElementById('drawerDescription'),
  drawerLots: document.getElementById('drawerLots'),
  minPriceInput: document.getElementById('minPriceInput'),
  maxPriceInput: document.getElementById('maxPriceInput'),
  applyLotsFilterButton: document.getElementById('applyLotsFilterButton')
};

init();

async function init() {
  bindUiEvents();
  bindBridgeEvents();
  await initialLoad();
}

function bindUiEvents() {
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
    els.refreshButton.addEventListener('click', () => {
      setStatus('Запросил обновление цен в игре...');
      emitToClient('ui:marketplace:requestInit');
    });
  }

  if (els.sortMenuButton) {
    els.sortMenuButton.addEventListener('click', (e) => {
      e.stopPropagation();
      els.sortPopover?.classList.toggle('hidden');
    });
  }

  els.sortOptions.forEach((button) => {
    button.addEventListener('click', () => {
      state.sortMode = button.dataset.sort === 'expensive' ? 'expensive' : 'cheap';
      updateSortButtons();
      els.sortPopover?.classList.add('hidden');
      render();
    });
  });

  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Node)) return;

    const insideSortButton = els.sortMenuButton?.contains(target);
    const insidePopover = els.sortPopover?.contains(target);

    if (!insideSortButton && !insidePopover) {
      els.sortPopover?.classList.add('hidden');
    }
  });

  if (els.closeDrawerButton) {
    els.closeDrawerButton.addEventListener('click', closeDrawer);
  }

  if (els.applyLotsFilterButton) {
    els.applyLotsFilterButton.addEventListener('click', () => {
      if (state.selectedItemId != null) {
        emitRequestLots(state.selectedItemId);
        renderDrawerLots();
      }
    });
  }
}

function bindBridgeEvents() {
  const altObj = window.alt;
  if (!altObj || typeof altObj.on !== 'function') return;

  try {
    altObj.on('ui:marketplace:status', (text) => {
      if (typeof text === 'string' && text.trim()) {
        setStatus(text);
      }
    });
  } catch {}

  try {
    altObj.on('ui:marketplace:initResult', (...args) => {
      applyInitResultPayload(args);
    });
  } catch {}

  try {
    altObj.on('ui:marketplace:pushLots', (lots) => {
      const normalized = Array.isArray(lots) ? lots : [];
      if (!normalized.length) return;

      const itemId = Number(normalized[0]?.itemId);
      if (Number.isNaN(itemId)) return;

      state.lotsByItemId.set(itemId, normalized);

      if (state.selectedItemId === itemId) {
        renderDrawerLots();
      }
    });
  } catch {}

  try {
    altObj.on('ui:marketplace:scriptDisabled', () => {
      setStatus('Скрипт отключен клавишей \\ до перезапуска ресурса');
      closeDrawer();
    });
  } catch {}
}

async function initialLoad() {
  state.items = [];
  state.itemsMap = new Map();
  state.categoryByItemId = {};
  state.categoryOrder = [];
  state.selectedItemId = null;
  state.stats = {
    total: 0,
    processed: 0,
    fromDb: 0,
    parsed: 0,
    saved: 0,
    errors: 0
  };

  closeDrawer();
  setStatus('Загружаю базу данных...');
  render();

  await buildFromGlist();

  if (!getFavoriteItems().length) {
    state.activeTab = 'items';
  }

  updateTabs();
  render();
}

async function buildFromGlist() {
  if (state.parseRunning) return;
  state.parseRunning = true;

  try {
    const response = await fetch(GLIST_URL);
    if (!response.ok) {
      throw new Error(`glist HTTP ${response.status}`);
    }

    const raw = await response.json();
    const queue = normalizeGlistToQueue(raw);

    state.stats.total = queue.length;
    queue.forEach((item) => addOrUpdateItem(item));

    renderSubtabs();
    render();

    setStatus(`Загрузилось ${queue.length} предметов. Читаю сохранённую базу...`);

    const dbMap = await preloadSupabaseRows(queue.map((x) => x.itemId));
    hydrateFromDb(dbMap);

    render();

    const parseQueue = state.items.filter((item) => !item.name || !item.name.trim());

    if (!parseQueue.length) {
      setStatus(buildStatusText());
      return;
    }

    setStatus(`База загружена. Нужно обработать ещё ${parseQueue.length} предметов...`);

    await processWithConcurrency(parseQueue, PARSE_CONCURRENCY, async (item) => {
      await enrichSingleItem(item.itemId);
    });

    setStatus(buildStatusText());
  } catch (error) {
    setStatus(`Не могу получить доступ к базе данных: ${error.message}`);
  } finally {
    state.parseRunning = false;
    render();
  }
}

function normalizeGlistToQueue(raw) {
  const map = new Map();
  const categories = [];

  Object.keys(raw || {}).forEach((groupName) => {
    categories.push(groupName);

    const ids = Array.isArray(raw[groupName]) ? raw[groupName] : [];
    ids.forEach((itemId) => {
      const id = Number(itemId);
      if (Number.isNaN(id)) return;

      state.categoryByItemId[id] = groupName;

      if (!map.has(id)) {
        map.set(id, {
          itemId: id,
          category: groupName,
          name: '',
          price: 1,
          totalQuantity: 0,
          image: buildDefaultImage(id),
          updatedAt: 0,
          statusText: 'Ожидание',
          parseError: '',
          description: ''
        });
      }
    });
  });

  state.categoryOrder = ['all', ...categories];
  return Array.from(map.values()).sort((a, b) => a.itemId - b.itemId);
}

async function preloadSupabaseRows(itemIds) {
  const result = new Map();

  for (let i = 0; i < itemIds.length; i += READ_BATCH_SIZE) {
    const batchIds = itemIds.slice(i, i + READ_BATCH_SIZE);

    const { data, error } = await supabase
      .from('items_catalog')
      .select('item_id, category, name, price, updated_at')
      .in('item_id', batchIds);

    if (error) continue;

    for (const row of data || []) {
      result.set(Number(row.item_id), row);
    }
  }

  return result;
}

function hydrateFromDb(dbMap) {
  for (const item of state.items) {
    const row = dbMap.get(item.itemId);
    if (!row) continue;

    item.category = row.category || item.category;
    item.name = row.name || item.name;
    item.price = normalizePrice(row.price, 1);
    item.updatedAt = row.updated_at ? new Date(row.updated_at).getTime() : item.updatedAt;
    item.statusText = 'Из базы';
    item.parseError = '';

    state.stats.fromDb++;
  }
}

async function enrichSingleItem(itemId) {
  const item = state.itemsMap.get(itemId);
  if (!item) return;

  try {
    item.statusText = 'Парсинг';
    item.parseError = '';
    renderLight();

    const resolved = await resolveItemMeta(item);

    if (!resolved?.name) {
      item.statusText = 'Не найдено';
      item.parseError = resolved?.reason || 'Название не найдено';
      state.stats.errors++;
      state.stats.processed++;
      renderLight();
      return;
    }

    item.name = resolved.name;
    item.description = resolved.description || '';
    item.price = normalizePrice(item.price, 1);
    item.updatedAt = Date.now();
    item.statusText = 'Сохранение';
    state.stats.parsed++;
    renderLight();

    await saveItemToSupabase(item);

    item.statusText = 'Готово';
    state.stats.saved++;
    state.stats.processed++;
    renderLight();

    if (state.selectedItemId === item.itemId) {
      syncDrawer(item);
    }
  } catch (error) {
    item.statusText = 'Ошибка';
    item.parseError = error.message;
    state.stats.errors++;
    state.stats.processed++;
    renderLight();
  }
}

async function resolveItemMeta(item) {
  const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, {
    body: {
      itemId: item.itemId,
      category: item.category,
      includeDescription: true
    }
  });

  if (error) {
    throw new Error(`Edge Function: ${error.message}`);
  }

  if (data?.ok) {
    return {
      name: data.name || '',
      description: data.description || '',
      reason: ''
    };
  }

  return {
    name: '',
    description: '',
    reason: data?.reason || 'Название не найдено'
  };
}

async function saveItemToSupabase(item) {
  const payload = {
    item_id: item.itemId,
    category: item.category,
    name: item.name,
    price: normalizePrice(item.price, 1),
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from('items_catalog')
    .upsert([payload], { onConflict: 'item_id' });

  if (error) {
    throw new Error(formatSupabaseError(error));
  }
}

function applyInitResultPayload(args) {
  const entries = extractMarketplaceItems(args);

  if (!entries.length) {
    setStatus('Сработал подпись такая: marketplace.client.initResult, но список предметов пуст');
    return;
  }

  let updated = 0;

  for (const row of entries) {
    const itemId = Number(row?.itemId);
    if (Number.isNaN(itemId)) continue;

    const item = state.itemsMap.get(itemId);
    if (!item) continue;

    item.price = normalizePrice(row?.startingBet, item.price || 1);

    const totalQuantity = Number(row?.totalQuantity || 0);
    item.totalQuantity = Number.isNaN(totalQuantity) ? 0 : totalQuantity;
    item.statusText = item.totalQuantity > 0 ? `Лотов: ${item.totalQuantity}` : 'Нет лотов';

    updated++;
  }

  setStatus(`Сработал подпись такая: marketplace.client.initResult | обновлено предметов: ${updated}`);
  renderLight();

  if (state.selectedItemId != null) {
    const current = state.itemsMap.get(state.selectedItemId);
    if (current) {
      syncDrawer(current);
    }
  }
}

function extractMarketplaceItems(args) {
  if (!Array.isArray(args)) return [];

  if (args.length >= 3 && Array.isArray(args[2])) {
    return args[2];
  }

  const directArray = args.find(
    (part) => Array.isArray(part) && part.some((x) => x && typeof x === 'object' && 'itemId' in x)
  );

  return Array.isArray(directArray) ? directArray : [];
}

function addOrUpdateItem(item) {
  const existing = state.itemsMap.get(item.itemId);

  if (existing) {
    Object.assign(existing, item);
  } else {
    state.items.push(item);
    state.itemsMap.set(item.itemId, item);
  }

  state.items.sort((a, b) => a.itemId - b.itemId);
}

async function processWithConcurrency(items, limit, worker) {
  let index = 0;

  async function runOne() {
    while (index < items.length) {
      const currentIndex = index++;
      const item = items[currentIndex];
      setStatus(`Обработка ${Math.min(state.stats.processed + state.stats.fromDb + 1, state.stats.total)}/${state.stats.total}`);
      await worker(item);
    }
  }

  const runners = [];
  for (let i = 0; i < limit; i++) {
    runners.push(runOne());
  }

  await Promise.all(runners);
}

function buildStatusText() {
  return `Готово. Всего: ${state.stats.total} | из базы: ${state.stats.fromDb} | спарсено: ${state.stats.parsed} | сохранено: ${state.stats.saved} | ошибок: ${state.stats.errors}`;
}

function formatSupabaseError(error) {
  const parts = [
    error?.message || '',
    error?.details || '',
    error?.hint || '',
    error?.code || ''
  ].filter(Boolean);

  return parts.join(' | ');
}

function normalizePrice(price, fallback = 1) {
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

  els.favoritesView?.classList.toggle('view--active', state.activeTab === 'favorites');
  els.itemsView?.classList.toggle('view--active', state.activeTab === 'items');

  if (els.itemsSubtabs) {
    els.itemsSubtabs.style.display = state.activeTab === 'items' ? 'flex' : 'none';
  }
}

function renderSubtabs() {
  if (!els.itemsSubtabs) return;

  const labels = {
    all: 'Все',
    ammunition: 'Амуниция',
    tool: 'Инструменты',
    misc: 'Разное',
    auto_parts: 'Автозапчасти',
    documents: 'Документы',
    medical: 'Медицина',
    food: 'Еда',
    alcohol: 'Алкоголь',
    fish: 'Рыба',
    equipment: 'Снаряжение',
    consumables: 'Расходники',
    facilities: 'Объекты',
    books: 'Книги',
    personals: 'Личное',
    products: 'Продукты',
    agriculture: 'Агро',
    drugs: 'Ингредиенты',
    armor: 'Броня',
    others: 'Другое'
  };

  els.itemsSubtabs.innerHTML = state.categoryOrder.map((category) => {
    const active = category === state.activeCategory;
    const text = labels[category] || category;
    return `<button class="subtab ${active ? 'subtab--active' : ''}" data-category="${escapeHtml(category)}">${escapeHtml(text)}</button>`;
  }).join('');

  els.itemsSubtabs.querySelectorAll('.subtab').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeCategory = button.dataset.category || 'all';
      renderSubtabs();
      render();
    });
  });
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
  localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(Array.from(state.favorites)));
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

function getFavoriteItems() {
  return state.items.filter((item) => state.favorites.has(item.itemId));
}

function getItemsForCurrentTab() {
  const base = state.activeTab === 'favorites'
    ? getFavoriteItems()
    : state.items.filter((item) => state.activeCategory === 'all' || item.category === state.activeCategory);

  const filtered = base.filter((item) => {
    const term = state.search;
    if (!term) return true;
    return (item.name || '').toLowerCase().includes(term) || String(item.itemId).includes(term);
  });

  filtered.sort((a, b) => {
    if (state.sortMode === 'expensive') {
      return Number(b.price || 0) - Number(a.price || 0);
    }
    return Number(a.price || 0) - Number(b.price || 0);
  });

  return filtered;
}

function updateSortButtons() {
  els.sortOptions.forEach((button) => {
    const mode = button.dataset.sort === 'expensive' ? 'expensive' : 'cheap';
    button.classList.toggle('sort-option--active', state.sortMode === mode);
  });
}

function render() {
  updateTabs();
  updateSortButtons();

  const items = getItemsForCurrentTab();

  if (state.activeTab === 'favorites') {
    renderGrid(els.favoritesGrid, items);
    if (els.favoritesEmpty) {
      els.favoritesEmpty.style.display = items.length ? 'none' : 'block';
    }
  } else {
    renderGrid(els.itemsGrid, items);
    if (els.itemsEmpty) {
      els.itemsEmpty.style.display = items.length ? 'none' : 'block';
    }
  }
}

let lightRenderQueued = false;
function renderLight() {
  if (lightRenderQueued) return;
  lightRenderQueued = true;
  requestAnimationFrame(() => {
    lightRenderQueued = false;
    render();
  });
}

function renderGrid(container, items) {
  if (!container) return;

  container.innerHTML = items.map((item) => {
    const isFavorite = state.favorites.has(item.itemId);
    const reason = item.parseError ? item.parseError.slice(0, 70) : '';
    return `
      <div class="item-card ${isFavorite ? 'item-card--favorite' : ''}" data-card-id="${item.itemId}" title="${escapeHtml(item.name || `Предмет #${item.itemId}`)}">
        <div class="item-card__price">${escapeHtml(formatPrice(item.price))}</div>
        <button class="item-card__favorite ${isFavorite ? 'item-card__favorite--active' : ''}" data-favorite-id="${item.itemId}" title="Избраное">★</button>
        <div class="item-card__image-wrap">
          <img class="item-card__image" src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name || `Предмет #${item.itemId}`)}" loading="lazy" />
        </div>
        <div class="item-card__body">
          <div class="item-card__name">${escapeHtml(item.name || `Предмет #${item.itemId}`)}</div>
          <div class="item-card__meta">${escapeHtml(item.statusText || '')}</div>
          ${reason ? `<div class="item-card__error">${escapeHtml(reason)}</div>` : ''}
        </div>
        <div class="item-card__id">${item.itemId}</div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-favorite-id]').forEach((button) => {
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const itemId = Number(button.dataset.favoriteId);
      toggleFavorite(itemId);
    });
  });

  container.querySelectorAll('[data-card-id]').forEach((card) => {
    card.addEventListener('click', () => {
      const itemId = Number(card.dataset.cardId);
      openDrawer(itemId);
    });
  });
}

async function openDrawer(itemId) {
  const item = state.itemsMap.get(itemId);
  if (!item || !els.detailsDrawer) return;

  state.selectedItemId = itemId;
  els.detailsDrawer.classList.remove('hidden');

  syncDrawer(item);
  emitRequestLots(item.itemId);
  renderDrawerLots();
}

function syncDrawer(item) {
  els.drawerTitle.textContent = item.name || `Предмет #${item.itemId}`;
  els.drawerSubtitle.textContent = `ID ${item.itemId}`;
  els.drawerImage.src = item.image;
  els.drawerDescription.textContent = item.description || 'Нет описания';
}

function closeDrawer() {
  state.selectedItemId = null;
  els.detailsDrawer?.classList.add('hidden');
}

function renderDrawerLots() {
  if (state.selectedItemId == null) return;
  const item = state.itemsMap.get(state.selectedItemId);
  if (!item) return;

  const source = state.lotsByItemId.get(item.itemId) || [];
  const minValue = els.minPriceInput?.value ?? '';
  const maxValue = els.maxPriceInput?.value ?? '';
  const min = Number(minValue);
  const max = Number(maxValue);

  const filtered = source.filter((lot) => {
    const price = Number(lot.price || 0);
    if (minValue !== '' && !Number.isNaN(min) && price < min) return false;
    if (maxValue !== '' && !Number.isNaN(max) && price > max) return false;
    return true;
  });

  const firstFive = filtered.slice(0, 5);

  els.drawerLots.textContent = firstFive.length
    ? firstFive.map((lot) => `${lot.id} | ${lot.accountId} ${lot.amount} ${lot.price}`).join('\n')
    : 'Нет данных';

  els.drawerDescription.textContent = item.description || 'Нет описания';
}

function emitRequestLots(itemId) {
  emitToClient('ui:marketplace:requestLots', itemId, 0, '{"sort":"priceUp"}');
}

function emitToClient(...args) {
  const altObj = window.alt;
  if (!altObj || typeof altObj.emit !== 'function') return;
  try {
    altObj.emit(...args);
  } catch {}
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
