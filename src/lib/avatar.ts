// GitHub serves avatars at full size (460px or more) unless asked otherwise.
// The avatar in this app is drawn at 28 CSS px (AVATAR_PX), so ask GitHub for a
// 64px copy: sharp on 2x screens and close to it on 3x, at a fraction of the bytes.
// Any other host, or a URL that does not parse, is returned unchanged.
export const AVATAR_PX = 28;
export const AVATAR_REQUEST_PX = 64;

export function avatarSrc(url: string, px: number = AVATAR_REQUEST_PX): string {
  try {
    const u = new URL(url);
    if (u.hostname !== "avatars.githubusercontent.com" && !u.hostname.endsWith(".githubusercontent.com")) return url;
    u.searchParams.set("s", String(px));
    return u.toString();
  } catch {
    return url;
  }
}
