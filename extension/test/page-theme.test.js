import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { pageThemeHint, effectiveBg, isLightPage, applyTheme } from "../src/ui/page-theme.js";

const page = (html = "", htmlAttrs = "") =>
  new JSDOM(`<!doctype html><html ${htmlAttrs}><body>${html}</body></html>`).window.document;

describe("pageThemeHint", () => {
  test("reads a dark or light class from <html> or <body>", () => {
    assert.equal(pageThemeHint(page("", 'class="dark"')), "dark");
    assert.equal(pageThemeHint(page("", 'class="light"')), "light");
    const d = page();
    d.body.className = "Theme-Dark";
    assert.equal(pageThemeHint(d), "dark");
  });

  test("reads data-theme, data-color-mode and data-color-scheme", () => {
    assert.equal(pageThemeHint(page("", 'data-theme="dark"')), "dark");
    assert.equal(pageThemeHint(page("", 'data-color-mode="light"')), "light");
    assert.equal(pageThemeHint(page("", 'data-color-scheme="dark-hc"')), "dark");
  });

  test("a class wins over an attribute", () => {
    assert.equal(pageThemeHint(page("", 'class="dark" data-theme="light"')), "dark");
  });

  test("reads CSS color-scheme, but not when it allows both", () => {
    const dark = page();
    dark.documentElement.style.colorScheme = "dark";
    assert.equal(pageThemeHint(dark), "dark");
    const both = page();
    both.documentElement.style.colorScheme = "light dark";
    assert.equal(pageThemeHint(both), null);
  });

  test("no signal gives null", () => {
    assert.equal(pageThemeHint(page()), null);
  });

  test("our own zs-light class is not the site's signal", () => {
    assert.equal(pageThemeHint(page("", 'class="zs-light"')), null);
    assert.equal(pageThemeHint(page("", 'class="zs-light dark"')), "dark");
    assert.equal(pageThemeHint(page("", 'class="zs-light light"')), "light");
  });
});

describe("effectiveBg", () => {
  test("takes the first opaque background going up from <body>", () => {
    const d = page('<div id="x"></div>');
    d.body.style.backgroundColor = "rgb(10, 20, 30)";
    assert.equal(effectiveBg(d), "rgb(10, 20, 30)");
  });

  test("falls back to <html>, then to white", () => {
    const d = page();
    d.documentElement.style.backgroundColor = "rgb(1, 2, 3)";
    assert.equal(effectiveBg(d), "rgb(1, 2, 3)");
    assert.ok(effectiveBg(page()).length > 0);
  });

  test("a transparent body is skipped", () => {
    const d = page();
    d.body.style.backgroundColor = "rgba(0, 0, 0, 0)";
    d.documentElement.style.backgroundColor = "rgb(9, 9, 9)";
    assert.equal(effectiveBg(d), "rgb(9, 9, 9)");
  });
});

describe("isLightPage", () => {
  test("the explicit hint wins over luminance", () => {
    const d = page("", 'class="dark"');
    d.body.style.backgroundColor = "rgb(255, 255, 255)";
    assert.equal(isLightPage(d), false);
  });

  test("without a hint, luminance decides", () => {
    const light = page();
    light.body.style.backgroundColor = "rgb(250, 250, 250)";
    assert.equal(isLightPage(light), true);
    const dark = page();
    dark.body.style.backgroundColor = "rgb(20, 20, 20)";
    assert.equal(isLightPage(dark), false);
  });

  test("an unreadable colour gives null", () => {
    const d = page();
    d.defaultView.getComputedStyle = () => ({ backgroundColor: "currentcolor", colorScheme: "" });
    assert.equal(isLightPage(d), null);
  });
});

describe("applyTheme", () => {
  test("sets and clears .zs-light on <html> as the page changes", () => {
    const d = page("", 'class="light"');
    applyTheme(d);
    assert.ok(d.documentElement.classList.contains("zs-light"));
    d.documentElement.className = "dark";
    applyTheme(d);
    assert.ok(!d.documentElement.classList.contains("zs-light"));
  });

  test("a page already marked zs-light can switch back to dark by luminance alone", () => {
    const d = page();
    d.documentElement.classList.add("zs-light");
    d.body.style.backgroundColor = "rgb(20, 20, 20)";
    applyTheme(d);
    assert.ok(!d.documentElement.classList.contains("zs-light"));
  });

  test("leaves the class alone when the colour cannot be read", () => {
    const d = page();
    d.defaultView.getComputedStyle = () => ({ backgroundColor: "currentcolor", colorScheme: "" });
    applyTheme(d);
    assert.ok(!d.documentElement.classList.contains("zs-light"));
    assert.equal(d.documentElement.className, "");
  });
});
