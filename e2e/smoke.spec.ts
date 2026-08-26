import { expect, test } from "@playwright/test";

test("renders the travel app shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "一鸣与美垚的旅行" })).toBeVisible();
  await expect(page.getByText("正在使用本地计划")).toBeVisible();
});

test("opens a day from the dynamic overview", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: /D3/ }).click();
  await expect(page).toHaveURL(/day\/day-2026-10-05/);
});

test("shows road-following route points and syncs a map marker to its timeline card", async ({ page }) => {
  await page.goto("/day/day-2026-10-05?__testRouteMap=1");

  const routePoints = page.locator("[data-route-points]");
  await expect(routePoints).toHaveAttribute("data-route-points", /[3-9]|[1-9]\d+/);

  const timelinePlace = page.getByRole("button", { name: "尖沙咀天星码头", exact: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(timelinePlace).not.toBeInViewport();
  await page.getByRole("button", { name: "在地图中定位 尖沙咀天星码头" }).evaluate((marker) => {
    (marker as HTMLButtonElement).click();
  });
  await expect(timelinePlace).toHaveAttribute("aria-current", "location");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(timelinePlace).toBeInViewport();
});

test("opens deletion in the browser modal layer", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "删除当天" });
  await trigger.click();
  const dialog = page.getByRole("alertdialog", { name: /删除 D1/ });

  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((element) => element.matches(":modal"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("reorders stable day IDs with the keyboard drag handle", async ({ page }) => {
  await page.goto("/");
  const firstHandle = page.getByRole("button", { name: "拖动 D1" });
  await firstHandle.focus();
  await page.keyboard.press("Space");
  await expect(firstHandle).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(20);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("status").filter({
    hasText: "Draggable item day-2026-10-03 was moved over droppable area day-2026-10-04",
  })).toBeVisible();
  await page.keyboard.press("Space");

  await expect.poll(async () =>
    page.getByRole("tab").evaluateAll((tabs) => tabs.map((tab) => tab.id)),
  ).toEqual([
    "day-tab-day-2026-10-04",
    "day-tab-day-2026-10-03",
    "day-tab-day-2026-10-05",
    "day-tab-day-2026-10-06",
    "day-tab-day-2026-10-07",
    "day-tab-day-2026-10-08",
  ]);
});

test("keeps the drag handle focused and inert during a delayed save", async ({ page }) => {
  await page.goto("/?__testSaveDelayMs=2000");
  const firstHandle = page.locator("#day-tab-day-2026-10-03 + .drag-handle");
  await firstHandle.focus();
  await page.keyboard.press("Space");
  await expect(firstHandle).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(20);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("status").filter({
    hasText: "Draggable item day-2026-10-03 was moved over droppable area day-2026-10-04",
  })).toBeVisible();
  await page.keyboard.press("Space");

  await expect.poll(() => firstHandle.evaluate((handle) => ({
    opacity: getComputedStyle(handle).opacity,
    cursor: getComputedStyle(handle).cursor,
    syncState: document.querySelector(".sync-bar")?.textContent,
    focused: document.activeElement === handle,
    nativeDisabled: (handle as HTMLButtonElement).disabled,
    ariaDisabled: handle.getAttribute("aria-disabled"),
  })), { timeout: 1500 }).toEqual({
    opacity: "0.45",
    cursor: "not-allowed",
    syncState: "正在保存",
    focused: true,
    nativeDisabled: false,
    ariaDisabled: "true",
  });

  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  await expect(firstHandle).not.toHaveAttribute("aria-pressed", "true");

  const source = await firstHandle.boundingBox();
  const target = await page.locator("#day-tab-day-2026-10-04 + .drag-handle").boundingBox();
  expect(source).not.toBeNull();
  expect(target).not.toBeNull();
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2);
  await expect(firstHandle).not.toHaveAttribute("aria-pressed", "true");
  await page.mouse.up();
  await expect(page.getByText("正在保存")).toBeVisible();

  await expect(page.getByText("正在使用本地计划")).toBeVisible();
  await expect(firstHandle).toHaveAccessibleName("拖动 D2");
  await expect(firstHandle).toBeFocused();
  await expect.poll(async () =>
    page.getByRole("tab").evaluateAll((tabs) => tabs.map((tab) => tab.id)),
  ).toEqual([
    "day-tab-day-2026-10-04",
    "day-tab-day-2026-10-03",
    "day-tab-day-2026-10-05",
    "day-tab-day-2026-10-06",
    "day-tab-day-2026-10-07",
    "day-tab-day-2026-10-08",
  ]);
});

test("restaurant drawer shows sourced details and restores focus on desktop", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop drawer coverage");
  await page.goto("/day/day-2026-10-05");
  const card = page.locator("#timeline-place-arabica-peak button");
  await card.click();
  const drawer = page.getByRole("dialog", { name: "%Arabica(香港凌霄阁店)" });
  await expect(drawer).toBeVisible();
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox?.x + drawerBox!.width).toBeCloseTo(page.viewportSize()!.width, 0);
  await expect(drawer.getByText(/HK\$45–60/)).toBeVisible();
  await expect(drawer.getByRole("link", { name: "小红书搜索" })).toBeVisible();
  await expect(drawer.getByRole("link", { name: "打开高德导航" })).toHaveAttribute("href", /uri\.amap\.com/);
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await expect(page.locator(".back-button").click({ timeout: 300 })).rejects.toThrow();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  await expect(page.locator("body")).toHaveCSS("overflow", "visible");
  await expect(card).toBeFocused();
});

test("attraction drawer uses partial then full mobile states", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-15", "mobile drawer coverage");
  await page.goto("/day/day-2026-10-05");
  await page.locator("#timeline-place-peak button").click();
  const drawer = page.getByRole("dialog", { name: "太平山顶" });
  await expect(drawer).toHaveAttribute("data-drawer-state", "partial");
  await expect(drawer.getByText("预计停留 120 分钟")).toBeVisible();
  await drawer.getByRole("button", { name: "展开详情" }).click();
  await expect(drawer).toHaveAttribute("data-drawer-state", "full");
  const fullBox = await drawer.boundingBox();
  expect(fullBox).toMatchObject({ x: 0, y: 0, width: page.viewportSize()!.width, height: page.viewportSize()!.height });
  await drawer.getByRole("link", { name: "官方订票" }).click({ modifiers: ["Meta"] });
});

test("uses the mobile drawer treatment below 800px", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "intermediate mobile breakpoint coverage");
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto("/day/day-2026-10-05");
  await page.locator("#timeline-place-peak button").click();
  const drawer = page.getByRole("dialog", { name: "太平山顶" });
  await expect(drawer).toHaveAttribute("data-drawer-state", "partial");
  await expect(drawer).toHaveCSS("bottom", "0px");
  await expect(drawer.getByRole("button", { name: "展开详情" })).toBeVisible();
  await expect(drawer.getByRole("link", { name: "雨天备选：凌霄阁室内区域" })).toBeVisible();
});

test("updates an open drawer when crossing the 800px breakpoint", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "responsive drawer coverage");
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto("/day/day-2026-10-05");
  await page.locator("#timeline-place-peak button").click();
  const drawer = page.getByRole("dialog", { name: "太平山顶" });
  await expect(drawer).toHaveAttribute("data-drawer-state", "full");
  await expect(drawer.getByRole("button", { name: "展开详情" })).toBeHidden();
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(drawer).toHaveAttribute("data-drawer-state", "partial");
  await expect(drawer.getByRole("button", { name: "展开详情" })).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(drawer).toHaveAttribute("data-drawer-state", "full");
  await expect(drawer.getByRole("button", { name: "展开详情" })).toBeHidden();
});
