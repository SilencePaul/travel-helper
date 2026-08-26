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
