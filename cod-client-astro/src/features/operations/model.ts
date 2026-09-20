export type OperationAgentRoute =
  | { kind: "detail"; id: string }
  | { kind: "none" };

/** Recognizes the confirmer detail URL when the static host serves the root fallback. */
export function parseOperationAgentRoute(pathname: string): OperationAgentRoute {
  const match = pathname.match(/^\/operations\/agents\/([^/]+)\/?$/);
  if (!match) return { kind: "none" };

  try {
    return { kind: "detail", id: decodeURIComponent(match[1]) };
  } catch {
    return { kind: "none" };
  }
}
