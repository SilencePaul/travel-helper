import { expect, test } from "@playwright/test";

test("renders the travel app shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /两个人，\s*一条向南的路线。/ })).toBeVisible();
  await expect(page.getByText("正在使用本地计划")).toBeVisible();
});

test("keeps representative shared controls and feedback layout persistent", async ({ page }) => {
  await page.goto("/");
  const primary = page.getByRole("button", { name: "更新日期" });
  const text = page.getByRole("button", { name: "酒店比较" });
  const danger = page.getByRole("button", { name: "删除当天" });
  const field = page.getByLabel("北京 → 深圳、珠海 → 北京机票（两人）已付金额");

  await expect.poll(() => primary.evaluate((element) => {
    const style = getComputedStyle(element);
    return { minHeight: style.minHeight, height: element.getBoundingClientRect().height, background: style.backgroundColor, radius: style.borderRadius };
  })).toMatchObject({ minHeight: "44px", height: 44, background: "rgb(32, 77, 63)", radius: "4px" });
  await expect.poll(() => text.evaluate((element) => {
    const style = getComputedStyle(element);
    return { minHeight: style.minHeight, height: element.getBoundingClientRect().height, background: style.backgroundColor, decoration: style.textDecorationLine };
  })).toMatchObject({ minHeight: "44px", height: 44, background: "rgba(0, 0, 0, 0)", decoration: "underline" });
  await expect.poll(() => danger.evaluate((element) => {
    const style = getComputedStyle(element);
    return { minHeight: style.minHeight, height: element.getBoundingClientRect().height, color: style.color };
  })).toMatchObject({ minHeight: "44px", height: 44, color: "rgb(132, 51, 37)" });
  await expect.poll(() => field.evaluate((element) => {
    const style = getComputedStyle(element);
    return { minHeight: style.minHeight, height: element.getBoundingClientRect().height, fontSize: style.fontSize, radius: style.borderRadius };
  })).toMatchObject({ minHeight: "44px", height: 44, fontSize: "16px", radius: "4px" });

  await text.focus();
  await expect.poll(() => text.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor };
  })).toEqual({ width: "3px", style: "solid", color: "rgb(168, 65, 42)" });

  await field.fill("80");
  const orderRow = field.locator("xpath=ancestor::li");
  const dirtyStatus = orderRow.locator(".order-row-status").filter({ hasText: "金额尚未保存" });
  await expect(dirtyStatus).toBeVisible();
  await expect.poll(() => orderRow.evaluate((row) => {
    const status = row.querySelector<HTMLElement>(".order-row-status")!;
    const controls = [...row.querySelectorAll<HTMLElement>("input, button, select")];
    return status.getBoundingClientRect().top >= Math.max(...controls.map((control) => control.getBoundingClientRect().bottom)) - 1;
  })).toBe(true);
});

test("bounds the date warning and wraps its actions", async ({ page }) => {
  await page.goto("/?__testDateWarning=1");
  await page.getByLabel("结束日期").fill("2026-10-04");
  await page.getByRole("button", { name: "更新日期" }).click();
  const warning = page.getByRole("dialog", { name: "这些订单关联的旅行日将被移除" });
  await expect(warning).toBeVisible();
  await expect.poll(() => warning.evaluate((dialog) => {
    const style = getComputedStyle(dialog);
    const actions = getComputedStyle(dialog.lastElementChild!);
    return { bounded: Number.parseFloat(style.maxHeight) <= window.innerHeight - 32, overflowY: style.overflowY, actionWrap: actions.flexWrap };
  })).toEqual({ bounded: true, overflowY: "auto", actionWrap: "wrap" });
});

test("opens a day from the dynamic overview", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: /D3/ }).click();
  await page.getByRole("button", { name: "查看当天详情" }).click();
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
  await expect(drawer.getByRole("link", { name: "小红书搜索（新窗口）" })).toBeVisible();
  await expect(drawer.getByRole("link", { name: "开始导航（新窗口）" })).toHaveAttribute("href", /uri\.amap\.com\/navigation/);
  await expect(drawer.getByRole("link", { name: "开始导航（新窗口）" })).toHaveAttribute("href", /callnative=1/);
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await expect(page.locator(".back-button").click({ timeout: 300 })).rejects.toThrow();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  await expect(page.locator("body")).toHaveCSS("overflow", "visible");
  await expect(card).toBeFocused();
});

test("shows seeded order totals and direct AMap launch fallback", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "总预算" })).toBeVisible();
  await expect(page.getByText("CNY 11,150.00 · 已付 0.00")).toBeVisible();
  await expect(page.getByText("北京 → 深圳、珠海 → 北京机票（两人）", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /D3/ }).click();
  await page.getByRole("button", { name: "查看当天详情" }).click();
  await page.locator("#timeline-place-peak button").click();
  const drawer = page.getByRole("dialog", { name: "太平山顶" });
  await expect(drawer.getByRole("link", { name: "开始导航（新窗口）" })).toHaveAttribute("href", /mode=walk/);
  await expect(drawer.getByRole("button", { name: "复制地址" })).toBeVisible();
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
  await drawer.getByRole("link", { name: "官方订票（新窗口）" }).click({ modifiers: ["Meta"] });
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
  await expect(drawer.getByRole("link", { name: "雨天备选：凌霄阁室内区域（新窗口）" })).toBeVisible();
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

test("selects a map-linked hotel and recalculates its stay after extending Hong Kong days", async ({ page }) => {
  await page.goto("/?__testRouteMap=1");
  await expect(page.getByRole("tab")).toHaveCount(6);
  await page.getByRole("tab", { name: /D3/ }).click();
  await page.getByRole("button", { name: "查看当天详情" }).click();
  await page.getByRole("button", { name: "返回行程总览" }).click();
  await page.getByRole("button", { name: "酒店比较" }).click();
  await expect(page.getByTestId("hotel-nights")).toHaveText("2 晚");
  await expect(page.getByTestId("hotel-commute")).toHaveText("52 分钟");
  await page.getByRole("button", { name: "选择此酒店" }).last().click();
  const selectedHotel = page.getByRole("button", { name: "已选此酒店" });
  await selectedHotel.hover();
  await expect.poll(() => selectedHotel.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  })).toEqual({ color: "rgb(255, 250, 242)", background: "rgb(24, 50, 41)" });
  await expect(page.getByRole("button", { name: "在地图中定位 香港百乐酒店" })).toHaveAttribute("aria-current", "location");
  await expect(page.getByTestId("hotel-total")).toHaveText("CNY 2266.09");
  await expect(page.getByTestId("hotel-commute")).toHaveText("88 分钟");
  await page.getByRole("button", { name: "返回行程总览" }).click();
  await page.getByRole("button", { name: "复制当天" }).click();
  await expect(page.getByRole("tab")).toHaveCount(7);
  await page.getByRole("button", { name: "复制当天" }).click();
  await expect(page.getByRole("tab")).toHaveCount(8);
  await page.getByRole("button", { name: "酒店比较" }).click();

  await expect(page.getByTestId("hotel-nights")).toHaveText("4 晚");
  await expect(page.getByRole("button", { name: "在地图中定位 香港百乐酒店" })).toHaveAttribute("aria-current", "location");
  await expect(page.getByTestId("hotel-total")).toHaveText("CNY 4532.17");
  await expect(page.getByTestId("hotel-commute")).toHaveText("176 分钟");
  await expect(page.getByTestId("hotel-steps")).toHaveText("8,000 步");
});
