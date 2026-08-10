<div align="center">
  <img width="1200" alt="ZiptoGit Banner" src="https://res.cloudinary.com/dhxupweze/image/upload/v1781201096/social_ibkkyg.png" />
</div>

# ZiptoGit

Push ZIP archives directly to GitHub repositories without Git CLI.

## Features

- Upload ZIP files
- Extract automatically
- Push directly to GitHub
- GitHub OAuth login
- Manage (browse/delete) existing repo files & folders
- Delete an entire repository (with confirmation)
- Automatic secret scanning/redaction before push
- Mobile friendly
- No Git commands required

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth App client secret |
| `APP_URL` | Yes | Public base URL (e.g. `https://ziptogit.in`) — must match the OAuth App's callback URL |
| `SESSION_SECRET` | Recommended | Random string used to sign the session cookie. Falls back to `GITHUB_CLIENT_SECRET` if unset (logs a warning) — set your own in production |

**Security note:** the GitHub access token is never sent to or stored in the browser. It lives only in an HttpOnly, signed session cookie, and all GitHub API calls are proxied through the server (`server/githubService.ts`). If you're upgrading from an older version of this app, existing users will need to disconnect and reconnect their GitHub account once, both to migrate off client-stored tokens and to grant the `delete_repo` OAuth scope used by the delete-repository feature.

## Live Demo

https://myappzip.onrender.com

follow developer on Instagram - https://www.instagram.com/_dipesh_08
