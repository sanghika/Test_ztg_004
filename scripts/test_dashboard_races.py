"""Production browser regressions for uploads, deletions, and sign-out.

Start the production build locally with the settings in README.md.
With Python Playwright and Chromium installed, run python scripts/test_dashboard_races.py.
Set CHROMIUM_PATH to use a system Chromium. Set ZTG_TEST_ORIGIN for a custom port. GitHub requests are mocked.
"""

import gzip
import io
import json
import os
import unittest
import zipfile
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright


ORIGIN = os.getenv("ZTG_TEST_ORIGIN", "http://localhost:3000")


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
            "user": {"login": "demo", "avatar_url": ""}, "repos": repos, "nextPage": None, "canDeleteRepository": True
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

    def test_delete_authorization_keeps_the_repo_selected_and_requests_confirmation(self):
        page = self.page
        granted = False

        def bootstrap(route):
            route.fulfill(json={
                "user": {"login": "demo", "avatar_url": ""},
                "repos": [{"id": 1, "name": "site", "full_name": "demo/site", "default_branch": "main"}],
                "nextPage": None,
                "canDeleteRepository": granted,
            })

        def consent(route):
            nonlocal granted
            granted = True
            route.fulfill(content_type="text/html", body=
                '<script>window.opener.postMessage({type:"OAUTH_AUTH_SUCCESS"}, location.origin); window.close();</script>')

        page.route("**/api/bootstrap", bootstrap)
        page.route("**/api/repo-tree?*", lambda route: route.fulfill(json={"tree": [], "truncated": False}))
        page.route("**/api/auth/url?intent=delete-repo", lambda route: route.fulfill(json={"url": ORIGIN + "/mock-consent"}))
        page.context.route("**/mock-consent", consent)

        page.goto(ORIGIN)
        page.get_by_role("button", name="Manage files").click()
        expect(page.get_by_role("button", name="Delete repository…")).to_have_count(0)
        page.get_by_role("button", name="Authorize repository deletion").click()
        page.get_by_role("button", name="Delete repository…").click()
        expect(page.get_by_role("combobox", name="Repository")).to_have_value("demo/site")
        expect(page.get_by_role("button", name="Delete forever")).to_be_disabled()

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


    def test_large_text_file_requires_confirmation_before_any_upload(self):
        page = self.page
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zipped:
            zipped.writestr("large.txt", "a" * (5 * 1024 * 1024 + 1))
            zipped.writestr(".env", "EXAMPLE=local")
        requests = []

        def upload(route):
            requests.append(route.request.url.rsplit("/", 1)[-1])
            if requests[-1] == "blobs":
                route.fulfill(json={"blobs": [{"path": "large.txt", "sha": "a" * 40}]})
            else:
                route.fulfill(json={"commit": {"sha": "b" * 40}})

        page.route("**/api/upload/*", upload)
        page.goto(ORIGIN)
        page.locator("input[type=file][accept]").set_input_files({
            "name": "large.zip", "mimeType": "application/zip", "buffer": buffer.getvalue()
        })
        section = page.get_by_role("region", name="Push files")
        push = section.get_by_role("button", name="Push files", exact=True)
        confirm = section.get_by_role("button", name="Push without scanning these files")
        push.click()
        expect(confirm).to_be_visible()
        expect(page.get_by_role("list", name="Files above the scan limit")).to_have_text("large.txt")
        self.assertEqual([], requests)

        page.get_by_role("combobox", name="Repository").select_option("demo/second")
        expect(confirm).to_have_count(0)
        push.click()
        expect(confirm).to_be_visible()
        self.assertEqual([], requests)
        confirm.click()
        expect(section.get_by_text("Pushed 1 file to demo/second")).to_be_visible()
        self.assertEqual(["blobs", "commit"], requests)

    def test_all_excluded_files_stop_before_upload(self):
        page = self.page
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as zipped:
            zipped.writestr(".env", "EXAMPLE=local")
        page.goto(ORIGIN)
        page.locator("input[type=file][accept]").set_input_files({
            "name": "excluded.zip", "mimeType": "application/zip", "buffer": buffer.getvalue()
        })
        page.get_by_role("region", name="Push files").get_by_role("button", name="Push files", exact=True).click()
        expect(page.get_by_role("alert")).to_contain_text("Every file was excluded.")

    def test_missing_file_tree_chunk_keeps_dashboard_available(self):
        page = self.page
        page.route("**/assets/RepoFileTree-*.js", lambda route: route.abort())
        page.route("**/api/repo-tree?*", lambda route: route.fulfill(json={
            "tree": [{"type": "blob", "path": "README.md", "sha": "a" * 40}], "truncated": False
        }))
        page.goto(ORIGIN)
        page.get_by_role("button", name="Manage files").click()
        expect(page.get_by_role("alert")).to_contain_text("Couldn’t open the file list.")
        expect(page.get_by_role("button", name="Reload page")).to_be_visible()
        page.get_by_role("button", name="Push files", exact=True).click()
        expect(page.get_by_role("button", name="Choose ZIP file")).to_be_visible()


    def test_retry_bootstrap_recovers_existing_account(self):
        page = self.page
        failures = []

        def temporarily_unavailable(route):
            failures.append(route.request.url)
            route.fulfill(status=503, json={"message": "Try again"})
            page.unroute("**/api/bootstrap", temporarily_unavailable)

        page.route("**/api/bootstrap", temporarily_unavailable)
        page.goto(ORIGIN)
        expect(page.get_by_role("heading", name="Couldn’t load your GitHub account")).to_be_visible()
        expect(page.get_by_role("button", name="Connect GitHub")).to_have_count(0)
        page.get_by_role("button", name="Retry loading account").click()
        expect(page.get_by_role("combobox", name="Repository")).to_have_value("demo/first")
        self.assertEqual(1, len(failures))

    def test_repository_picker_is_locked_until_creation_finishes(self):
        page = self.page
        pending = []
        page.route("**/api/repos", lambda route: pending.append(route))
        page.goto(ORIGIN)
        picker = page.get_by_role("combobox", name="Repository")
        picker.select_option("__create_new_repo__")
        page.get_by_role("textbox", name="New repository name").fill("new-repo")
        with page.expect_request("**/api/repos"):
            page.get_by_role("button", name="Create repository", exact=True).click()
        expect(picker).to_be_disabled()
        pending[0].fulfill(json={
            "id": 3, "name": "new-repo", "full_name": "demo/new-repo", "default_branch": "main"
        })
        expect(picker).to_have_value("demo/new-repo")
        expect(picker).to_be_enabled()
        picker.select_option("demo/second")
        expect(picker).to_have_value("demo/second")

    def test_dropped_folder_read_errors_leave_the_picker_usable(self):
        page = self.page
        page.goto(ORIGIN)
        drop_zone = page.get_by_role("button", name="Choose ZIP file").locator("..")
        for failed_entry in ["folder", "file"]:
            with self.subTest(failed_entry=failed_entry):
                drop_zone.evaluate("""(zone, failedEntry) => {
                    const nestedFile = {
                        name: "example.txt", isFile: true,
                        file: (_, onError) => onError(new DOMException("Unavailable", "NotReadableError")),
                    };
                    DataTransferItem.prototype.webkitGetAsEntry = () => {
                        let read = false;
                        return {
                            name: "project", isDirectory: true,
                            createReader: () => ({
                                readEntries: (onSuccess, onError) => {
                                    if (failedEntry === "folder") return onError(new DOMException("Unavailable"));
                                    onSuccess(read ? [] : [nestedFile]);
                                    read = true;
                                },
                            }),
                        };
                    };
                    const dataTransfer = new DataTransfer();
                    dataTransfer.items.add(new File(["placeholder"], "example.txt"));
                    zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
                }""", failed_entry)
                message = 'Could not read folder "project".' if failed_entry == "folder" else 'Could not read "project/example.txt".'
                expect(page.get_by_role("alert")).to_have_text(message)
                expect(page.get_by_role("button", name="Choose ZIP file")).to_be_enabled()
                expect(page.get_by_text("Reading folder…")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
