import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AttractionPlace, RestaurantPlace } from "@travel/contracts";
import { expect, test, vi } from "vitest";
import { PlaceDrawer } from "./PlaceDrawer";
import placeDrawerSource from "./PlaceDrawer.tsx?raw";

const sources = [
  { label: "官方资料", url: "https://example.com/official", kind: "official" as const, checkedAt: "2026-08-26T00:00:00.000Z" },
  { label: "小红书搜索", url: "https://www.xiaohongshu.com/search_result", kind: "community" as const, checkedAt: "2026-08-26T00:00:00.000Z" },
];

const restaurant: RestaurantPlace = {
  id: "arabica-peak", type: "restaurant", name: "% Arabica 山顶凌霄阁店",
  address: "香港山顶道128号凌霄阁G17", coordinate: { lng: 114.150192, lat: 22.270851, coordinateSystem: "GCJ02" },
  summary: "山顶行程中的咖啡停靠。", updatedAt: "2026-08-26T00:00:00.000Z",
  averagePrice: "HK$45–60 / 人", signatureDishes: ["Caffè Latte", "Kyoto Latte"],
  twoPersonOrder: "两杯咖啡预算 HK$90–120", hours: "08:00–19:00（周一至周五）；08:00–21:00（周末及公众假期）",
  queueNote: "高峰时段以现场为准", reservationUrl: "https://arabicacoffee.hk/",
  images: [{ url: "https://example.com/coffee.jpg", alt: "% Arabica 店内咖啡", licenseOrOwner: "© % Arabica Hong Kong" }], sources,
};

const attraction: AttractionPlace = {
  id: "peak", type: "attraction", name: "太平山顶", address: "香港山顶道128号",
  coordinate: { lng: 114.150192, lat: 22.270851, coordinateSystem: "GCJ02" }, summary: "俯瞰维港天际线。",
  updatedAt: "2026-08-26T00:00:00.000Z", ticketPrice: "山顶缆车来回成人 HK$108（官方公布，2024-12-30起）",
  hours: "山顶缆车 07:30–23:00；凌霄阁摩天台 428 08:30–22:00", stayMinutes: 120,
  bestTime: "日落前抵达，衔接夜景", crowdNote: "节假日可能实施人流管理，官方建议提前购票。",
  photoSpots: ["凌霄阁摩天台 428", "卢吉道观景位"], rainAlternativeId: "peak-tower",
  bookingUrl: "https://ticketing.thepeak.com.hk/", images: [{ url: "https://example.com/peak.jpg", alt: "太平山顶维港景观", licenseOrOwner: "© Hong Kong Tourism Board" }], sources,
};

test("restaurant drawer shows sourced food details and navigation", async () => {
  const user = userEvent.setup();
  render(<><button type="button">打开餐厅</button><PlaceDrawer place={restaurant} triggerRef={{ current: null }} onClose={() => undefined} /></>);
  expect(screen.getByRole("dialog", { name: restaurant.name })).toBeVisible();
  expect(screen.getByAltText("% Arabica 店内咖啡")).toBeVisible();
  expect(screen.getByText("HK$45–60 / 人")).toBeVisible();
  expect(screen.getByText("两杯咖啡预算 HK$90–120")).toBeVisible();
  expect(screen.getByText("Caffè Latte")).toBeVisible();
  expect(screen.getByRole("link", { name: /官方资料.*2026年8月26日/ })).toBeVisible();
  expect(screen.getByRole("link", { name: "小红书搜索（新窗口）" })).toBeVisible();
  const navigation = screen.getByRole("link", { name: "开始导航（新窗口）" });
  expect(navigation).toHaveAttribute("href", expect.stringContaining("uri.amap.com/navigation"));
  expect(navigation).toHaveAttribute("href", expect.stringContaining("callnative=1"));
  await user.click(navigation);
});

test("gives the restaurant website and source links exact new-window accessible names", () => {
  render(<PlaceDrawer place={restaurant} triggerRef={{ current: null }} onClose={() => undefined} />);

  expect(screen.getByRole("link", { name: "查看餐厅官网（新窗口）" })).toHaveAttribute("target", "_blank");
  expect(screen.getByRole("link", { name: "官方资料 · 2026年8月26日（新窗口）" })).toHaveAttribute("target", "_blank");
  expect(screen.getByRole("link", { name: "小红书搜索 · 2026年8月26日（新窗口）" })).toHaveAttribute("target", "_blank");
});

test("attraction drawer shows visit details and official booking", () => {
  render(<PlaceDrawer place={attraction} rainAlternative={{ ...attraction, id: "peak-tower", name: "凌霄阁室内区域" }} triggerRef={{ current: null }} onClose={() => undefined} />);
  expect(screen.getByText(/HK\$108/)).toBeVisible();
  expect(screen.getByText("预计停留 120 分钟")).toBeVisible();
  expect(screen.getByText("日落前抵达，衔接夜景")).toBeVisible();
  expect(screen.getByText("卢吉道观景位")).toBeVisible();
  expect(screen.getByRole("link", { name: "雨天备选：凌霄阁室内区域（新窗口）" })).toHaveAttribute("href", "https://example.com/official");
  expect(screen.getByRole("link", { name: "官方订票（新窗口）" })).toHaveAttribute("href", attraction.bookingUrl);
});

test("modal drawer isolates the app and locks document scroll until close", () => {
  const appRoot = document.createElement("div");
  appRoot.id = "root";
  document.body.append(appRoot);
  const trigger = document.createElement("button");
  document.body.append(trigger);
  const { unmount } = render(<PlaceDrawer place={restaurant} triggerRef={{ current: trigger }} onClose={() => undefined} />);
  expect(appRoot).toHaveAttribute("inert");
  expect(document.body.style.overflow).toBe("hidden");
  fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(appRoot).not.toHaveAttribute("inert");
  expect(document.body.style.overflow).toBe("");
  unmount();
  appRoot.remove();
  trigger.remove();
});

test("escape closes the desktop drawer and restores its triggering card", () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  const onClose = () => { trigger.focus(); };
  render(<PlaceDrawer place={restaurant} triggerRef={{ current: trigger }} onClose={onClose} />);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(trigger).toHaveFocus();
  trigger.remove();
});

test("mobile drawer exposes partial and full states", async () => {
  const user = userEvent.setup();
  render(<PlaceDrawer place={restaurant} triggerRef={{ current: null }} onClose={() => undefined} mobile />);
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveAttribute("data-drawer-state", "partial");
  const expand = screen.getByRole("button", { name: "展开详情" });
  const controlledRegion = document.getElementById(expand.getAttribute("aria-controls") ?? "");
  expect(expand).toHaveAttribute("aria-expanded", "false");
  expect(controlledRegion).toBeInTheDocument();
  await user.click(expand);
  expect(dialog).toHaveAttribute("data-drawer-state", "full");
  expect(screen.getByRole("button", { name: "收起详情" })).toHaveAttribute("aria-expanded", "true");
  await user.click(screen.getByRole("button", { name: "关闭详情" }));
  expect(dialog).not.toBeInTheDocument();
});

test("copies the address when clipboard access succeeds", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<PlaceDrawer place={restaurant} triggerRef={{ current: null }} onClose={() => undefined} />);
  await user.click(screen.getByRole("button", { name: "复制地址" }));
  expect(writeText).toHaveBeenCalledWith(restaurant.address);
  expect(await screen.findByText("地址已复制")).toBeVisible();
});

test("offers a selectable manual address when clipboard access is unavailable or rejected", async () => {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  render(<PlaceDrawer place={restaurant} triggerRef={{ current: null }} onClose={() => undefined} />);
  await user.click(screen.getByRole("button", { name: "复制地址" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("无法自动复制，请手动复制下方地址");
  expect(screen.getByText("手动复制地址", { exact: true })).toBeVisible();
  expect(screen.getByRole("textbox", { name: "手动复制地址" })).toHaveValue(restaurant.address);
});

test("models copy outcomes structurally instead of inferring failure from localized text", () => {
  expect(placeDrawerSource).toMatch(/"success"\s*\|\s*"error"/);
  expect(placeDrawerSource).not.toContain(".startsWith(");
});
