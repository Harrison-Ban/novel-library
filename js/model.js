// 분류 체계(그룹·항목·파일 태그)를 다루는 함수와 변경 op 모음
export const PALETTE = ['#c0392b', '#2563eb', '#f59e0b', '#16a34a', '#7c3aed', '#db2777', '#0891b2', '#6b7280'];

export const NONE = '__none'; // 미분류 칸·필터 키

export function newId(prefix) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function defaultGroups() {
  return [
    { id: 'g-genre', name: '장르', type: 'folder', order: 0, items: [] },
    {
      id: 'g-country', name: '국가', type: 'virtual', order: 1,
      items: [
        { id: 'i-kr', name: '한국', color: '#2563eb', order: 0 },
        { id: 'i-cn', name: '중국', color: '#c0392b', order: 1 },
        { id: 'i-jp', name: '일본', color: '#db2777', order: 2 },
      ],
    },
    {
      id: 'g-status', name: '상태', type: 'virtual', order: 2,
      items: [
        { id: 'i-best', name: '베스트', color: '#f59e0b', order: 0 },
        { id: 'i-del', name: '삭제예정', color: '#6b7280', order: 1 },
        { id: 'i-reading', name: '읽는중', color: '#16a34a', order: 2 },
      ],
    },
  ];
}

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.name ?? '').localeCompare(b.name ?? '', 'ko');

export function sortedGroups(lib) {
  return [...lib.groups].sort(byOrder);
}

export function findGroup(lib, groupId) {
  return lib.groups.find((g) => g.id === groupId);
}

// 그룹의 항목(칸) 목록: { key, name, color }
// 폴더 연결 그룹은 실제 하위 폴더에서 읽고 색상·순서만 저장값을 쓴다
export function groupItems(group, scan) {
  if (group.type === 'folder') {
    const stored = new Map(group.items.map((i) => [i.folderId, i]));
    return (scan?.folders ?? [])
      .map((f, i) => {
        const s = stored.get(f.id);
        return { key: f.id, name: f.name, color: s?.color ?? PALETTE[i % PALETTE.length], order: s?.order ?? 1000 + i };
      })
      .sort(byOrder);
  }
  return [...group.items].sort(byOrder).map((i) => ({ key: i.id, name: i.name, color: i.color, order: i.order }));
}

export function fileTags(lib, fileId) {
  return lib.files[fileId]?.tags ?? [];
}

// 이 그룹에서 파일이 속한 칸 키 목록 (없으면 [NONE])
export function fileKeysInGroup(lib, group, file) {
  if (group.type === 'folder') return [file.folderId ?? NONE];
  const ids = new Set(group.items.map((i) => i.id));
  const keys = fileTags(lib, file.id).filter((t) => ids.has(t));
  return keys.length ? keys : [NONE];
}

// ---------- 변경 op (같은 op를 다른 기기 데이터에 다시 적용해도 안전해야 한다) ----------

function maxOrder(list) {
  return list.reduce((m, x) => Math.max(m, x.order ?? 0), -1);
}

function setFileTags(d, fileId, tags) {
  const entry = d.files[fileId] ?? {};
  entry.tags = [...new Set(tags)];
  if (!entry.tags.length) delete entry.tags;
  if (Object.keys(entry).length) d.files[fileId] = entry;
  else delete d.files[fileId];
}

function stripTags(d, itemIds) {
  const remove = new Set(itemIds);
  for (const id of Object.keys(d.files)) {
    const tags = d.files[id].tags ?? [];
    if (tags.some((t) => remove.has(t))) setFileTags(d, id, tags.filter((t) => !remove.has(t)));
  }
}

export const ops = {
  initDefaults: () => (d) => {
    if (!d.groups.length) d.groups = defaultGroups();
  },

  setRoot: (folderId) => (d) => {
    d.rootFolderId = folderId;
  },

  // 앱 내 항목 붙이기·떼기
  tag: (fileIds, add = [], remove = []) => (d) => {
    const rm = new Set(remove);
    for (const id of fileIds) {
      const tags = (d.files[id]?.tags ?? []).filter((t) => !rm.has(t));
      setFileTags(d, id, [...tags, ...add]);
    }
  },

  // 앱 내 그룹에서 칸 이동: from 칸에서 떼고 to 칸에 붙인다. to가 NONE이면 이 그룹 항목을 모두 뗀다.
  // from이 없으면(일괄 이동) 이 그룹 항목을 모두 떼고 to만 붙인다.
  moveInGroup: (fileIds, groupId, from, to) => (d) => {
    const g = findGroup(d, groupId);
    if (!g || g.type !== 'virtual') return;
    const groupIds = new Set(g.items.map((i) => i.id));
    if (to !== NONE && !groupIds.has(to)) return;
    for (const id of fileIds) {
      let tags = d.files[id]?.tags ?? [];
      if (to === NONE || from == null) tags = tags.filter((t) => !groupIds.has(t));
      else tags = tags.filter((t) => t !== from);
      if (to !== NONE) tags = [...tags, to];
      setFileTags(d, id, tags);
    }
  },

  addGroup: (groupId, name) => (d) => {
    if (findGroup(d, groupId)) return;
    d.groups.push({ id: groupId, name, type: 'virtual', order: maxOrder(d.groups) + 1, items: [] });
  },

  renameGroup: (groupId, name) => (d) => {
    const g = findGroup(d, groupId);
    if (g) g.name = name;
  },

  deleteGroup: (groupId) => (d) => {
    const g = findGroup(d, groupId);
    if (!g || g.type !== 'virtual') return;
    stripTags(d, g.items.map((i) => i.id));
    d.groups = d.groups.filter((x) => x.id !== groupId);
  },

  reorderGroups: (groupIds) => (d) => {
    groupIds.forEach((id, i) => {
      const g = findGroup(d, id);
      if (g) g.order = i;
    });
  },

  addItem: (groupId, itemId, name, color) => (d) => {
    const g = findGroup(d, groupId);
    if (!g || g.type !== 'virtual' || g.items.some((i) => i.id === itemId)) return;
    g.items.push({ id: itemId, name, color, order: maxOrder(g.items) + 1 });
  },

  renameItem: (groupId, itemId, name) => (d) => {
    const item = findGroup(d, groupId)?.items.find((i) => i.id === itemId);
    if (item) item.name = name;
  },

  deleteItem: (groupId, itemId) => (d) => {
    const g = findGroup(d, groupId);
    if (!g || g.type !== 'virtual') return;
    g.items = g.items.filter((i) => i.id !== itemId);
    stripTags(d, [itemId]);
  },

  // entries: [{ key, color }] 화면 순서대로. 폴더 연결 그룹은 폴더 ID별 색상·순서를 저장한다.
  setItemsLayout: (groupId, entries) => (d) => {
    const g = findGroup(d, groupId);
    if (!g) return;
    if (g.type === 'folder') {
      const prev = new Map(g.items.map((i) => [i.folderId, i]));
      for (const [i, e] of entries.entries()) prev.set(e.key, { folderId: e.key, color: e.color, order: i });
      g.items = [...prev.values()];
    } else {
      entries.forEach((e, i) => {
        const item = g.items.find((x) => x.id === e.key);
        if (item) Object.assign(item, { color: e.color, order: i });
      });
    }
  },

  // 마지막으로 연 시각 (최근 읽음 목록용)
  markOpened: (fileId, at) => (d) => {
    d.files[fileId] = { ...(d.files[fileId] ?? {}), openedAt: at };
  },

  // 읽던 위치 (0~1)
  setPos: (fileId, pos) => (d) => {
    d.files[fileId] = { ...(d.files[fileId] ?? {}), lastPos: pos };
  },

  // 책갈피: { id, pos(0~1), snippet, at } — id로 구분해 여러 기기에서 동시에 추가해도 합쳐진다
  addBookmark: (fileId, bookmark) => (d) => {
    const entry = d.files[fileId] ?? {};
    const list = (entry.bookmarks ?? []).filter((b) => b.id !== bookmark.id);
    entry.bookmarks = [...list, bookmark].sort((a, b) => a.pos - b.pos);
    d.files[fileId] = entry;
  },

  removeBookmark: (fileId, bookmarkId) => (d) => {
    const entry = d.files[fileId];
    if (!entry?.bookmarks) return;
    entry.bookmarks = entry.bookmarks.filter((b) => b.id !== bookmarkId);
    if (!entry.bookmarks.length) delete entry.bookmarks;
  },

  // 리더 공유 설정 (줄 간격·테마·넘기기 방식). 글자 크기·여백은 기기별로 따로 둔다.
  setReaderPrefs: (patch) => (d) => {
    d.readerPrefs = { ...(d.readerPrefs ?? {}), ...patch };
  },

  // 작업 기록 (최근 것이 앞, 300개까지)
  log: (entries) => (d) => {
    d.log = [...entries, ...(d.log ?? [])].slice(0, 300);
  },

  // OneDrive에서 사라진 파일의 분류 정보 정리
  forgetFiles: (fileIds) => (d) => {
    for (const id of fileIds) delete d.files[id];
  },
};
