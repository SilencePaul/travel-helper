import { expect, test } from "@playwright/test";

test("renders the travel app shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "一鸣与美垚的旅行" })).toBeVisible();
  await expect(page.getByText("正在使用本地计划")).toBeVisible();
});
