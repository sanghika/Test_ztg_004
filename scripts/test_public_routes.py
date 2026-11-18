"""Public route checks against the production build.

Start the app with npm run build && NODE_ENV=production npm start.
With Python Playwright and Chromium installed, run python scripts/test_public_routes.py.
Set CHROMIUM_PATH to use a system Chromium.
"""

import os
import unittest

from playwright.sync_api import expect, sync_playwright


ORIGIN = "http://localhost:3000"


class PublicRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        cls.browser = cls.playwright.chromium.launch(executable_path=os.getenv("CHROMIUM_PATH"))
        cls.addClassCleanup(cls.browser.close)

    def test_not_found_works_without_javascript_and_aliases_redirect(self):
        context = self.browser.new_context(java_script_enabled=False)
        self.addCleanup(context.close)
        page = context.new_page()
        response = page.goto(f"{ORIGIN}/missing-page")
        self.assertEqual(404, response.status)
        expect(page.get_by_role("heading", name="Page not found")).to_be_visible()
        expect(page.get_by_role("link", name="Go to homepage")).to_have_attribute("href", "/")
        expect(page.locator('meta[name="robots"]')).to_have_attribute("content", "noindex, follow")
        for path, expected in [("/index.html", "/"), ("/faq/index.html?from=legacy", "/faq?from=legacy")]:
            response = page.goto(ORIGIN + path)
            self.assertEqual(308, response.request.redirected_from.response().status)
            self.assertEqual(ORIGIN + expected, page.url)
        asset = context.request.get(f"{ORIGIN}/assets/missing.js")
        self.assertEqual(404, asset.status)
        self.assertIn("text/plain", asset.headers["content-type"])

    def test_metadata_scroll_and_focus_follow_navigation(self):
        page = self.browser.new_page(viewport={"width": 1280, "height": 550})
        self.addCleanup(page.close)
        page.goto(f"{ORIGIN}/")
        footer = page.get_by_role("navigation", name="Footer")
        faq = footer.get_by_role("link", name="FAQ")
        faq.scroll_into_view_if_needed()
        page.wait_for_function("scrollY > 0")
        previous_scroll = page.evaluate("scrollY")
        faq.click()
        expect(page).to_have_title("FAQ | ZiptoGit")
        expect(page.get_by_role("heading", level=1)).to_be_focused()
        self.assertEqual(0, page.evaluate("scrollY"))
        expect(page.locator('link[rel="canonical"]')).to_have_attribute("href", "https://ziptogit.in/faq")
        expect(page.locator('meta[property="og:title"]')).to_have_attribute("content", "FAQ | ZiptoGit")
        expect(page.locator('meta[name="twitter:description"]')).to_have_attribute("content",
            "Answers to common questions about ZiptoGit: security, cost, and using it with private repositories.")
        page.go_back()
        expect(page).to_have_title("ZiptoGit - Push ZIP Archives Directly to GitHub")
        self.assertEqual(previous_scroll, page.evaluate("scrollY"))

    def test_mobile_escape_returns_focus_to_menu_button(self):
        page = self.browser.new_page(viewport={"width": 390, "height": 844})
        self.addCleanup(page.close)
        page.goto(f"{ORIGIN}/")
        menu = page.get_by_role("button", name="Open menu")
        menu.click()
        page.get_by_role("navigation", name="Site menu").get_by_role("link").first.focus()
        page.keyboard.press("Escape")
        expect(menu).to_be_focused()
        expect(menu).to_have_attribute("aria-expanded", "false")


if __name__ == "__main__":
    unittest.main()
