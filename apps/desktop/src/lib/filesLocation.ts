// Where the Files tree is: one remembered folder per tree, base-relative, kept
// in this browser so returning to Files continues where the user was — and so
// a link can open the tree on a folder ("Show in Files").
const FILE_LOCATIONS_KEY = "openscience.files.locations.v1";
export const GLOBAL_FILES_LOCATION = "base";

function safeDirectory(value: unknown): string {
  if (typeof value !== "string" || value.startsWith("/") || value.includes("\\")) return "";
  return value.split("/").some((part) => part === "..") ? "" : value;
}

function fileLocations(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const value = JSON.parse(window.localStorage.getItem(FILE_LOCATIONS_KEY) ?? "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).map(([key, dir]) => [key, safeDirectory(dir)]),
    );
  } catch {
    return {};
  }
}

export function rememberedDirectory(key: string): string {
  return fileLocations()[key] ?? "";
}

export function rememberDirectory(key: string, dir: string): void {
  if (typeof window === "undefined") return;
  const locations = fileLocations();
  locations[key] = safeDirectory(dir);
  try {
    window.localStorage.setItem(FILE_LOCATIONS_KEY, JSON.stringify(locations));
  } catch {
    // Browsing still works when storage is unavailable or full.
  }
}
