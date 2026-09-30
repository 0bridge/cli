// No imports: the web dashboard bundles this for the browser.

/**
 * Services whose MCP server doesn't let 0bridge register itself (no dynamic client
 * registration), so each user registers an OAuth app with the service once and hands 0bridge
 * its client id and secret. Keyed by the MCP server's host.
 */
export interface AppSetup {
  /** "Slack" */
  name: string;
  /** Where the service lists the scopes its MCP server asks for (OAuth protected resource metadata). */
  scopesUrl: string;
  /** A link that opens the service's "create app" page with everything filled in. */
  createUrl(callbackUrl: string, scopes: string[]): string;
  /** What to click after the link opens, in order. `site` is the 0bridge server (for its icon). */
  steps(site: string): string[];
}

/**
 * Slack's MCP server accepts only Marketplace apps and apps internal to one workspace, so every
 * workspace gets its own small internal app. A manifest link fills in the name, the callback,
 * the scopes and the MCP switch; the user only picks the workspace and installs it.
 */
const slack: AppSetup = {
  name: "Slack",
  scopesUrl: "https://mcp.slack.com/.well-known/oauth-protected-resource",
  createUrl(callbackUrl, scopes) {
    const manifest = {
      display_information: {
        name: "0bridge",
        description: "Use this workspace from your AI tools through 0bridge.",
        long_description:
          "Lets Claude Code, Codex, Cursor and other AI tools connected to your 0bridge account search and read this workspace and post as you, through Slack's MCP server. Only you can use it: it is installed for your account, and 0bridge keeps its tokens encrypted.",
        background_color: "#111111",
      },
      oauth_config: { redirect_urls: [callbackUrl], scopes: { user: scopes } },
      settings: { is_mcp_enabled: true, org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: true },
    };
    return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
  },
  steps: (site) => [
    "Pick the workspace to connect, then Next → Create",
    "Install App → Install to <workspace> → Allow",
    `Optional: Basic Information → Display Information → App icon: upload ${site}/icon.png (the manifest can't set it)`,
    "Basic Information → App Credentials: copy the Client ID and the Client Secret (Show)",
  ],
};

export const APP_SETUP: Record<string, AppSetup> = { "mcp.slack.com": slack };

export function appSetupFor(url: string): AppSetup | undefined {
  try {
    return APP_SETUP[new URL(url).host];
  } catch {
    return undefined;
  }
}
