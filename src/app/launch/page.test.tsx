import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/dom";
import LaunchPage, { metadata } from "./page";

const h = vi.hoisted(() => ({ live: false }));
vi.mock("@/lib/launch/address", () => ({ hasLaunchpad: () => h.live, LAUNCHPAD_ADDRESS: undefined }));
vi.mock("@/components/LaunchForm", () => ({ default: () => <div>the launch form</div> }));
vi.mock("@/components/YourLaunches", () => ({ default: () => <div>your launches</div> }));

describe("/launch (instant launchpad design, section 7.2)", () => {
  it("is titled Launch", () => {
    expect(metadata.title).toBe("Launch");
  });

  it("shows only the not-live card while the launchpad address is unset", () => {
    h.live = false;
    render(<LaunchPage />);
    expect(screen.getByText("Launching is not live yet")).toBeTruthy();
    expect(screen.getByText("Token launches open here once the launchpad contract is deployed.")).toBeTruthy();
    expect(screen.queryByText("the launch form")).toBeNull();
    expect(screen.queryByText("your launches")).toBeNull();
  });

  it("shows the form once it is set, and the wallet's own launches under it (amended 30 Sep 2026)", () => {
    h.live = true;
    const { container } = render(<LaunchPage />);
    expect(screen.getByText("the launch form")).toBeTruthy();
    expect(screen.queryByText("Launching is not live yet")).toBeNull();
    expect(container.textContent).toMatch(/the launch form.*your launches/);
  });
});
