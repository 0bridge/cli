// No imports: the web dashboard bundles this for the browser.

/**
 * Well-known remote MCP servers, so `0b connect linear` just works; anything else is still found by
 * `0b connect <name>` (discover.ts). Each was checked to answer as an MCP server. Most let a new app
 * sign in on its own (OAuth dynamic registration) or need no sign-in; the few that accept only apps
 * registered with them ahead of time (Asana, GitHub, HubSpot, PagerDuty, Render) ask for one the
 * user registers (--client-id), unless 0bridge has its own (apps.ts: Slack).
 */
export const PRESETS: Record<string, string> = {
  airtable: "https://mcp.airtable.com/mcp",
  amplitude: "https://mcp.amplitude.com/mcp",
  apify: "https://mcp.apify.com",
  asana: "https://mcp.asana.com/v2/mcp",
  atlassian: "https://mcp.atlassian.com/v1/mcp",
  attio: "https://mcp.attio.com/mcp",
  "aws-knowledge": "https://knowledge-mcp.global.api.aws",
  axiom: "https://mcp.axiom.co/mcp",
  buildkite: "https://mcp.buildkite.com/mcp",
  canva: "https://mcp.canva.com/mcp",
  clickup: "https://mcp.clickup.com/mcp",
  close: "https://mcp.close.com/mcp",
  cloudflare: "https://mcp.cloudflare.com/mcp",
  "cloudflare-docs": "https://docs.mcp.cloudflare.com/mcp",
  cloudinary: "https://asset-management.mcp.cloudinary.com/mcp",
  context7: "https://mcp.context7.com/mcp",
  datadog: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
  deepwiki: "https://mcp.deepwiki.com/mcp",
  dropbox: "https://mcp.dropbox.com/mcp",
  exa: "https://mcp.exa.ai/mcp",
  figma: "https://mcp.figma.com/mcp",
  fireflies: "https://api.fireflies.ai/mcp",
  gamma: "https://mcp.gamma.app/mcp",
  github: "https://api.githubcopilot.com/mcp/",
  gitlab: "https://gitlab.com/api/v4/mcp",
  grafana: "https://mcp.grafana.com/mcp",
  granola: "https://mcp.granola.ai/mcp",
  hex: "https://app.hex.tech/mcp",
  honeycomb: "https://mcp.honeycomb.io/mcp",
  hubspot: "https://mcp.hubspot.com",
  huggingface: "https://huggingface.co/mcp",
  intercom: "https://mcp.intercom.com/mcp",
  jam: "https://mcp.jam.dev/mcp",
  launchdarkly: "https://mcp.launchdarkly.com/mcp/fm",
  linear: "https://mcp.linear.app/mcp",
  mercury: "https://mcp.mercury.com/mcp",
  "microsoft-learn": "https://learn.microsoft.com/api/mcp",
  miro: "https://mcp.miro.com/",
  mixpanel: "https://mcp.mixpanel.com/mcp",
  monday: "https://mcp.monday.com/mcp",
  motherduck: "https://api.motherduck.com/mcp",
  neon: "https://mcp.neon.tech/mcp",
  netlify: "https://netlify-mcp.netlify.app/mcp",
  notion: "https://mcp.notion.com/mcp",
  "openai-docs": "https://developers.openai.com/mcp",
  pagerduty: "https://mcp.pagerduty.com/mcp",
  paypal: "https://mcp.paypal.com/mcp",
  planetscale: "https://mcp.pscale.dev/mcp/planetscale",
  posthog: "https://mcp.posthog.com/mcp",
  prisma: "https://mcp.prisma.io/mcp",
  railway: "https://mcp.railway.com/mcp",
  ramp: "https://mcp.ramp.com/mcp",
  render: "https://mcp.render.com/mcp",
  resend: "https://mcp.resend.com/mcp",
  sanity: "https://mcp.sanity.io",
  semgrep: "https://mcp.semgrep.ai/mcp",
  sentry: "https://mcp.sentry.dev/mcp",
  slack: "https://mcp.slack.com/mcp",
  socket: "https://mcp.socket.dev/",
  square: "https://mcp.squareup.com/mcp",
  stripe: "https://mcp.stripe.com",
  supabase: "https://mcp.supabase.com/mcp",
  todoist: "https://ai.todoist.net/mcp",
  vercel: "https://mcp.vercel.com",
  webflow: "https://mcp.webflow.com/mcp",
  wix: "https://mcp.wix.com/mcp",
  zapier: "https://mcp.zapier.com/api/mcp/mcp",
};

/**
 * Connectors of kind "api": HTTP APIs 0bridge calls for the user (the gateway's apis.ts has their
 * tools). `0b connect google-calendar` signs in with Google; `0b connect channeltalk` asks for its keys.
 */
export const API_CONNECTORS: Record<string, { title: string; auth: "oauth" | "key"; keys?: string[]; where?: string }> = {
  "google-calendar": { title: "Google Calendar", auth: "oauth" },
  // Slack's Web API through 0bridge's Slack app, while Slack's MCP server takes only Marketplace
  // apps (and a workspace's own). `0b connect slack` still means the MCP server; this is --app 0bridge.
  slack: { title: "Slack (0bridge's app)", auth: "oauth" },
  // Two keys, asked one by one; the gateway sends each in its own header.
  channeltalk: { title: "Channel Talk", auth: "key", keys: ["Access Key", "Access Secret"], where: "Channel Desk › Settings › API key management › Create new credential" },
};

/**
 * Services whose MCP only lets apps they've reviewed sign in (they check the redirect URL), and
 * haven't approved 0bridge's gateway yet. `0b connect` adds these to each AI tool directly
 * instead: Claude Code, Codex and Cursor are approved, so each signs in on its own.
 */
export const DIRECT_ONLY: Record<string, string> = {
  vercel: "Vercel lets only apps it has reviewed sign in, and hasn't approved 0bridge yet",
  figma: "Figma lets only apps it has reviewed sign in, and hasn't approved 0bridge yet",
};
