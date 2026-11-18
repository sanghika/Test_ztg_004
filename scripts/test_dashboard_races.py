"""Production browser regressions for uploads, deletions, and sign-out.

Start the app with npm run build && NODE_ENV=production npm start.
With Python Playwright and Chromium installed, run python scripts/test_dashboard_races.py.
Set CHROMIUM_PATH to use a system Chromium. GitHub requests are mocked.
"""

import gzip
import io
import json
import os
import unittest
import zipfile
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright


ORIGIN = "http://localhost:3000"


def archive(name):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zipped:
        zipped.writestr(f"{name}.txt", name)
    return {"name": f"{name}.zip", "mimeType": "application/zip", "buffer": buffer.getvalue()}


class DashboardRaces(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        cls.browser = cls.playwright.chromium.launch(executable_path=os.getenv("CHROMIUM_PATH"))
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        self.addCleanup(context.close)
        context.add_cookies([{"name": "has_session", "value": "1", "url": ORIGIN}])
        self.page = context.new_page()
        self.page.route("**/api/**", lambda route: route.abort())
        repos = [
            {"id": i, "name": name, "full_name": f"demo/{name}", "default_branch": "main"}
            for i, name in enumerate(["first", "second"], start=1)
        ]
        self.page.route("**/api/bootstrap", lambda route: route.fulfill(json={
            "user": {"login": "demo", "avatar_url": ""}, "repos": repos, "nextPage": None
        }))

    def test_replaced_zip_cannot_supply_commit_contents(self):
        page = self.page
        # Hold the first job before its real worker receives it. Await its final
        # message so the stale job has actually finished when we click Push.
        page.add_init_script("""
            const post = Worker.prototype.postMessage;
            Worker.prototype.postMessage = function(message, ...rest) {
                if (message.file?.name !== "first.zip") return post.call(this, message, ...rest);
                window.finishFirst = () => new Promise(resolve => {
                    this.addEventListener("message", event => {
                        if (event.data.type === "done") requestAnimationFrame(() => requestAnimationFrame(resolve));
                    });
                    post.call(this, message, ...rest);
                });
            };
        """)
        commits = []

        def record_commit(route):
            raw = route.request.post_data_buffer
            if route.request.headers.get("content-encoding") == "gzip":
                raw = gzip.decompress(raw)
            commits.append(json.loads(raw))
            route.fulfill(json={"commit": {"sha": "a" * 40}})

        page.route("**/api/upload/commit", record_commit)
        page.goto(ORIGIN)
        picker = page.locator("input[type=file][accept]")
        picker.set_input_files(archive("first"))
        page.wait_for_function("typeof window.finishFirst === 'function'")
        page.get_by_role("button", name="Remove selected files").click()
        picker.set_input_files(archive("second"))
        push = page.get_by_role("button", name="Push files", exact=True).last
        expect(push).to_be_enabled()
        page.evaluate("window.finishFirst()")
        expect(page.get_by_text("second.zip", exact=True)).to_be_visible()
        push.click()
        expect(page.get_by_role("button", name="Push more files")).to_be_visible()
        self.assertEqual([["second.txt"]], [[e["path"] for e in c["entries"]] for c in commits])

    def test_delete_completion_keeps_new_repository_tree_and_selection(self):
        page = self.page
        pending = []

        def tree(route):
            repo = parse_qs(urlsplit(route.request.url).query)["repo"][0]
            route.fulfill(json={"tree": [{"type": "blob", "path": f"{repo}.md", "sha": "b" * 40}],
                                "truncated": False})

        page.route("**/api/repo-tree?*", tree)
        page.route("**/api/delete-paths", lambda route: pending.append(route))
        page.goto(ORIGIN)
        page.get_by_role("button", name="Manage files").click()
        page.get_by_text("first.md", exact=True).click()
        delete = page.get_by_role("button", name="Delete 1 selected")
        with page.expect_request("**/api/delete-paths"):
            delete.click()
        page.get_by_role("combobox", name="Repository").select_option("demo/second")
        page.get_by_text("second.md", exact=True).click()
        self.assertEqual("first", pending[0].request.post_data_json["repo"])
        pending[0].fulfill(content_type="application/x-ndjson", body='{"done":true,"commit":{}}\n')
        # Re-enabling this selection means the pending deletion has settled.
        expect(delete).to_be_enabled()
        expect(page.get_by_text("second.md", exact=True)).to_be_visible()
        expect(page.get_by_role("checkbox")).to_be_checked()
        expect(page.get_by_text("first.md", exact=True)).to_have_count(0)
        expect(page.get_by_text("Deleted 1 item(s) successfully.")).to_have_count(0)


    def test_delete_requires_correct_owner_for_same_named_repositories(self):
        page = self.page
        repos = [
            {"id": i, "name": "site", "full_name": f"{owner}/site", "default_branch": "main"}
            for i, owner in enumerate(["personal", "company"], start=1)
        ]
        page.route("**/api/bootstrap", lambda route: route.fulfill(json={
            "user": {"login": "demo", "avatar_url": ""}, "repos": repos, "nextPage": None
        }))
        page.route("**/api/repo-tree?*", lambda route: route.fulfill(json={"tree": [], "truncated": False}))
        requests = []

        def delete_repo(route):
            requests.append(route.request.post_data_json)
            route.fulfill(json={"ok": True})

        page.route("**/api/repo", delete_repo)
        page.goto(ORIGIN)
        page.get_by_role("button", name="Manage files").click()
        picker = page.get_by_role("combobox", name="Repository")
        expect(picker.locator("option[value='personal/site']")).to_have_text("personal/site")
        expect(picker.locator("option[value='company/site']")).to_have_text("company/site")
        picker.select_option("company/site")
        expect(page.get_by_role("heading", name="Files in company/site")).to_be_visible()
        page.get_by_role("button", name="Delete repository…").click()
        confirmation = page.get_by_role("textbox", name="Full repository name to confirm deletion")
        delete = page.get_by_role("button", name="Delete forever")
        for wrong_name in ["site", "personal/site"]:
            confirmation.fill(wrong_name)
            expect(delete).to_be_disabled()
        confirmation.fill("company/site")
        expect(delete).to_be_enabled()
        delete.click()
        expect(picker.locator("option[value='company/site']")).to_have_count(0)
        expect(picker.locator("option[value='personal/site']")).to_have_count(1)
        self.assertEqual([{"owner": "company", "repo": "site"}], requests)

    def test_failed_logout_preserves_dashboard_and_can_retry(self):
        page = self.page

        for width in [390, 1280]:
            with self.subTest(width=width):
                pending = []
                page.set_viewport_size({"width": width, "height": 844})
                page.context.add_cookies([{"name": "has_session", "value": "1", "url": ORIGIN}])
                page.route("**/api/logout", lambda route: pending.append(route))
                page.goto(ORIGIN)
                disconnect = page.get_by_role("button", name="Disconnect", exact=False)
                repo_picker = page.get_by_role("combobox", name="Repository")
                with page.expect_request("**/api/logout"):
                    disconnect.click()
                expect(page.get_by_role("button", name="Disconnecting…")).to_be_disabled()
                expect(repo_picker).to_be_visible()
                pending[0].fulfill(status=503, json={"message": "Unavailable"})
                expect(page.get_by_role("alert")).to_have_text("Couldn’t confirm sign-out. Try again.")
                expect(repo_picker).to_be_visible()
                with page.expect_request("**/api/logout"):
                    page.get_by_role("button", name="Retry disconnect").click()
                pending[1].fulfill(json={"ok": True}, headers={"set-cookie": "has_session=; Max-Age=0; Path=/"})
                expect(page.get_by_role("button", name="Connect GitHub")).to_be_visible()
                page.reload()
                expect(page.get_by_role("button", name="Connect GitHub")).to_be_visible()
                expect(repo_picker).to_have_count(0)
                page.unroute("**/api/logout")


if __name__ == "__main__":
    unittest.main()
