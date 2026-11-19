"""Public route checks against the production build.

Start the production build locally with the settings in README.md.
With Python Playwright and Chromium installed, run python scripts/test_public_routes.py.
Set CHROMIUM_PATH to use a system Chromium. Set ZTG_TEST_ORIGIN for a custom port.
"""

import os
import unittest

from playwright.sync_api import expect, sync_playwright


ORIGIN = os.getenv("ZTG_TEST_ORIGIN", "http://localhost:3000")


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
        for path, expected in [
            ("/index.html", "/"),
            ("/FAQ/index.html?from=legacy", "/faq?from=legacy"),
            ("/FAQ", "/faq"),
            ("/faq/?utm_source=test&via=%2F", "/faq?utm_source=test&via=%2F"),
            ("/f%61q", "/faq"),
        ]:
            response = context.request.get(ORIGIN + path, max_redirects=0)
            self.assertEqual(308, response.status, path)
            self.assertEqual(expected, response.headers["location"])
        canonical = context.request.get(f"{ORIGIN}/faq?utm_source=test", max_redirects=0)
        self.assertEqual(200, canonical.status)
        alias_head = context.request.head(f"{ORIGIN}/FAQ/", max_redirects=0)
        self.assertEqual(308, alias_head.status)
        self.assertEqual("/faq", alias_head.headers["location"])
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
        expect(page).to_have_title("GitHub ZIP uploads: limits, permissions and pricing | ZiptoGit")
        expect(page.get_by_role("heading", level=1)).to_be_focused()
        self.assertEqual(0, page.evaluate("scrollY"))
        expect(page.locator('link[rel="canonical"]')).to_have_attribute("href", "https://ziptogit.in/faq")
        expect(page.locator('meta[property="og:title"]')).to_have_attribute("content", "GitHub ZIP uploads: limits, permissions and pricing | ZiptoGit")
        expect(page.locator('meta[name="twitter:description"]')).to_have_attribute("content",
            "Find out what you can upload to GitHub with ZiptoGit, how much it costs, and which permissions it requests for public and private repositories.")
        page.go_back()
        expect(page).to_have_title("ZiptoGit - Push ZIP Archives Directly to GitHub")
        self.assertEqual(previous_scroll, page.evaluate("scrollY"))

    def test_uploader_loads_only_when_navigating_to_home(self):
        page = self.browser.new_page()
        self.addCleanup(page.close)
        page.goto(f"{ORIGIN}/faq")
        self.assertFalse(page.evaluate(
            "performance.getEntriesByType('resource').some(entry => entry.name.includes('/ZipUploader-'))"
        ))
        page.evaluate("window.startedOnFaq = true")
        with page.expect_response("**/assets/ZipUploader-*.js"):
            page.get_by_role("link", name="ZiptoGit").click()
        heading = page.get_by_role("heading", name="Upload a ZIP file to GitHub")
        expect(heading).to_be_focused()
        expect(page.get_by_role("button", name="Connect GitHub")).to_be_visible()
        self.assertTrue(page.evaluate("window.startedOnFaq"))

        page.reload()
        self.assertEqual(1, page.locator('link[rel="modulepreload"][href*="/ZipUploader-"]').count())
        expect(heading).to_be_visible()

    def test_failed_uploader_download_can_be_recovered_by_reloading(self):
        page = self.browser.new_page()
        self.addCleanup(page.close)
        chunk = "**/assets/ZipUploader-*.js"
        page.route(chunk, lambda route: route.abort())
        page.goto(f"{ORIGIN}/faq")
        page.get_by_role("link", name="ZiptoGit").click()
        expect(page.get_by_role("heading", name="Couldn’t load the uploader")).to_be_visible()
        expect(page.get_by_role("navigation", name="Footer")).to_be_visible()

        page.unroute(chunk)
        with page.expect_navigation():
            page.get_by_role("button", name="Reload page").click()
        expect(page.get_by_role("heading", name="Upload a ZIP file to GitHub")).to_be_visible()
        page.get_by_role("button", name="Switch to dark mode").click()
        expect(page.locator("html")).to_have_class("dark")

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
