// Team/account links live inside a collapsed sidebar disclosure.
export async function openTeamAccountMenu(page) {
  const summary = page.locator('summary').filter({ hasText: /^团队与账户$/ });
  await summary.waitFor({ state: 'visible' });
  if (await summary.locator('..').getAttribute('open') === null) await summary.click();
}

export async function openTask(page, title, workspace = '验证 / 交付') {
  const sidebar = page.getByRole('complementary', { name: '工作台侧边栏', exact: true });
  await sidebar.locator('.wb-sidebar-switch').getByRole('button', { name: '任务', exact: true }).click();
  await sidebar.getByRole('navigation', { name: '任务', exact: true }).getByTitle(title, { exact: true }).click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  await showTaskPanel(page, workspace);
}

export async function showTaskPanel(page, name) {
  await page.getByRole('navigation', { name: '任务工作区', exact: true }).getByRole('button', { name, exact: true }).click();
}

export function taskAgent(page) {
  return page.getByRole('complementary', { name: '当前任务 AI 面板', exact: true });
}

export async function showAgentTab(page, name) {
  const toggle = page.getByRole('button', { name: '打开 AI 面板', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await taskAgent(page).getByRole('tab', { name, exact: true }).click();
}

const mobileAiState = new WeakMap();
const mobileSidebarState = new WeakMap();
export async function resizeWorkspace(page, size) {
  await page.setViewportSize(size);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (size.width <= 760) {
    const closeSidebar = page.getByRole('complementary', { name: '工作台侧边栏', exact: true }).getByRole('button', { name: '收起侧栏', exact: true });
    const wasOpen = await closeSidebar.isVisible();
    if (!mobileSidebarState.has(page)) mobileSidebarState.set(page, wasOpen);
    if (wasOpen) await closeSidebar.click();
  } else if (mobileSidebarState.has(page)) {
    if (mobileSidebarState.get(page)) {
      const openSidebar = page.getByRole('button', { name: '展开侧栏', exact: true });
      if (await openSidebar.isVisible()) await openSidebar.click();
    }
    mobileSidebarState.delete(page);
  }
  if (size.width <= 1000) {
    const close = page.getByRole('button', { name: '收起 AI 面板', exact: true });
    const wasOpen = await close.isVisible();
    if (!mobileAiState.has(page)) mobileAiState.set(page, wasOpen);
    if (wasOpen) await close.click();
  } else if (mobileAiState.has(page)) {
    if (mobileAiState.get(page)) {
      const open = page.getByRole('button', { name: '打开 AI 面板', exact: true });
      if (await open.isVisible()) await open.click();
    }
    mobileAiState.delete(page);
  }
}
