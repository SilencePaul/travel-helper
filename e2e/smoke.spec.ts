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
