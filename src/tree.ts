// 树形视图：递归 DOM 渲染，懒展开

export function renderTree(data: unknown, container: HTMLElement): void {
  container.innerHTML = '';
  const root = createNode(data, 'root');
  container.appendChild(root);
}

function createNode(value: unknown, key: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';

  if (value !== null && typeof value === 'object') {
    const isArray = Array.isArray(value);
    const entries = isArray
      ? (value as unknown[]).map((v, i) => [String(i), v] as [string, unknown])
      : Object.entries(value as Record<string, unknown>);
    const open = isArray ? '[' : '{';
    const close = isArray ? ']' : '}';
    const count = entries.length;

    // 折叠头
    const header = document.createElement('div');
    header.className = 'tree-line';

    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    toggle.textContent = '▶';

    const label = document.createElement('span');
    label.innerHTML = (key !== 'root' ? `<span class="tree-key">${esc(key)}</span>: ` : '') +
      `<span class="tree-bracket">${open}</span>` +
      `<span style="color:var(--text-muted)"> ${count} items </span>` +
      `<span class="tree-bracket">${close}</span>`;

    header.appendChild(toggle);
    header.appendChild(label);
    wrapper.appendChild(header);

    // 子节点容器（默认折叠）
    const children = document.createElement('div');
    children.style.display = 'none';
    for (const [k, v] of entries) {
      children.appendChild(createNode(v, k));
    }
    wrapper.appendChild(children);

    // 展开/折叠
    toggle.addEventListener('click', () => {
      const expanded = children.style.display !== 'none';
      children.style.display = expanded ? 'none' : 'block';
      toggle.textContent = expanded ? '▶' : '▼';
      // 更新折叠预览文本
      if (expanded) {
        label.innerHTML = (key !== 'root' ? `<span class="tree-key">${esc(key)}</span>: ` : '') +
          `<span class="tree-bracket">${open}</span>` +
          `<span style="color:var(--text-muted)"> ${count} items </span>` +
          `<span class="tree-bracket">${close}</span>`;
      } else {
        label.innerHTML = (key !== 'root' ? `<span class="tree-key">${esc(key)}</span>: ` : '') +
          `<span class="tree-bracket">${open}</span><span class="tree-bracket">${close}</span>`;
      }
    });
  } else {
    // 叶子节点
    const line = document.createElement('div');
    line.className = 'tree-line';
    line.style.paddingLeft = '1.25rem';
    line.innerHTML = `<span class="tree-key">${esc(key)}</span>: ${formatValue(value)}`;
    wrapper.appendChild(line);
  }

  return wrapper;
}

function formatValue(value: unknown): string {
  if (value === null) return '<span class="tree-null">null</span>';
  if (typeof value === 'string') return `<span class="tree-string">"${esc(value)}"</span>`;
  if (typeof value === 'number') return `<span class="tree-number">${value}</span>`;
  if (typeof value === 'boolean') return `<span class="tree-boolean">${value}</span>`;
  return esc(String(value));
}

function esc(text: string): string {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}
