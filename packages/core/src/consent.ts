/**
 * The cookie choice for PostHog on 0bridge.dev: one banner, shared by the gateway's public pages
 * (ui.ts) and the dashboard (apps/web root.tsx), which are one origin, so one choice covers both.
 *
 * - Until someone chooses, and after Reject, PostHog runs cookieless (`cookieless_mode:
 *   "on_reject"` with consent pending treated as rejected): page views only, no cookie, no
 *   localStorage identifier, no clicks, errors or timings, never tied to an account.
 * - Accept is the full setup each surface had before (cookies, clicks on public pages, the
 *   account id in the dashboard).
 * - A browser that sends Do Not Track or Global Privacy Control counts as Reject until its
 *   user picks otherwise.
 *
 * The choice is kept in localStorage (`0b-consent`). The script exposes `window.zbConsent`
 * ({ choice, set, open, clear }) and fires a `0b-consent` event on window with the new choice;
 * any element with `data-consent="open"` (the footers' "Cookie settings") opens the banner again.
 * After Reject, whatever PostHog kept on the device (its `ph_*` cookie and localStorage) is
 * removed once the page's PostHog has opted out (`clear`, which the dashboard calls again after
 * its PostHog, loaded asynchronously, has).
 * Server-side tool-call analytics (gateway analytics.ts) store nothing on the device and aren't
 * affected; the privacy policy discloses them.
 *
 * The script and style are strings for inline <script>/<style>: no backticks or dollar-braces in
 * them (they sit in template literals).
 */

export const CONSENT_KEY = "0b-consent";
export type ConsentChoice = "accept" | "reject";

/** The banner, hidden until the script decides to ask. Accept and Reject look the same: neither is preselected. */
export const CONSENT_BANNER = `<div id="zbc" class="zbc" role="dialog" aria-modal="false" aria-labelledby="zbc-t" aria-describedby="zbc-d" hidden><p id="zbc-t" class="zbc-t">Analytics cookies</p><p id="zbc-d" class="zbc-d">May we use cookies to see how the site is used (PostHog)? If not, we only count page views, anonymously, and store nothing on your device. <a href="/policy/privacy#cookies">Details</a></p><p class="zbc-now" hidden></p><div class="zbc-a"><button type="button" data-consent="reject">Reject</button><button type="button" data-consent="accept">Accept</button></div></div>`;

/** Its own colors, so it looks the same on the public pages and in the dashboard, light and dark. */
export const CONSENT_STYLE = `.zbc{--zbc-bg:#fff;--zbc-fg:#080808;--zbc-muted:#62666c;--zbc-line:#e6e6e6;--zbc-hover:#f5f5f5;position:fixed;z-index:60;left:16px;right:16px;bottom:16px;max-width:440px;margin:0 auto;padding:18px 20px 20px;border:1px solid var(--zbc-line);border-radius:16px;background:var(--zbc-bg);color:var(--zbc-fg);box-shadow:0 16px 40px rgba(0,0,0,.12);font:14px/1.55 "Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;text-align:left;-webkit-font-smoothing:antialiased}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .zbc{--zbc-bg:#121212;--zbc-fg:#f2f2f2;--zbc-muted:#8d9198;--zbc-line:#27272a;--zbc-hover:#1b1b1b;box-shadow:0 16px 40px rgba(0,0,0,.5)}}
:root[data-theme="dark"] .zbc{--zbc-bg:#121212;--zbc-fg:#f2f2f2;--zbc-muted:#8d9198;--zbc-line:#27272a;--zbc-hover:#1b1b1b;box-shadow:0 16px 40px rgba(0,0,0,.5)}
.zbc[hidden],.zbc [hidden]{display:none}
.zbc p{margin:0}
.zbc-t{font-size:15px;font-weight:500;margin-bottom:4px!important}
.zbc-d,.zbc-now{color:var(--zbc-muted)}
.zbc-now{margin-top:6px!important;font-size:13px}
.zbc a{color:inherit;text-decoration:underline;text-underline-offset:3px}
.zbc-a{display:flex;gap:8px;margin-top:14px}
.zbc-a button{flex:1 1 0;height:38px;padding:0 16px;border:1px solid var(--zbc-line);border-radius:999px;background:transparent;color:var(--zbc-fg);font:inherit;font-weight:500;cursor:pointer;transition:background .15s}
.zbc-a button:hover{background:var(--zbc-hover)}
.zbc-a button:focus-visible,.zbc a:focus-visible{outline:2px solid var(--zbc-fg);outline-offset:2px}
@media (min-width:720px){.zbc{left:24px;right:auto;bottom:24px;margin:0}}`;

/**
 * The choice: what was stored, else Reject for Do Not Track or Global Privacy Control, else null
 * (ask). Shows the banner when null; `open()` shows it again with the current choice named.
 */
export const CONSENT_SCRIPT = `(function(){
var K="${CONSENT_KEY}",w=window,d=document,B=${JSON.stringify(CONSENT_BANNER)},el=null;
function stored(){try{var v=w.localStorage.getItem(K);return v==="accept"||v==="reject"?v:null}catch(e){return null}}
function signal(){var n=w.navigator||{};return n.globalPrivacyControl===true||n.doNotTrack==="1"||w.doNotTrack==="1"}
function choice(){return stored()||(signal()?"reject":null)}
function banner(){if(!el){d.body.insertAdjacentHTML("beforeend",B);el=d.getElementById("zbc")}return el}
function show(focus){var b=banner(),c=choice(),now=b.querySelector(".zbc-now");if(c){now.textContent="Now: "+(c==="accept"?"accepted":"rejected")+(stored()?".":" (your browser asks not to be tracked).");now.hidden=false}else now.hidden=true;b.hidden=false;if(focus){var f=b.querySelector("button");if(f)f.focus()}}
function hide(){if(el)el.hidden=true}
function clear(){try{var dom="."+w.location.hostname.split(".").slice(-2).join(".");d.cookie.split(";").forEach(function(c){var n=c.split("=")[0].trim();if(n.indexOf("ph_")===0){d.cookie=n+"=; Max-Age=0; path=/";d.cookie=n+"=; Max-Age=0; path=/; domain="+dom}});var s=w.localStorage;for(var i=s.length-1;i>=0;i--){var k=s.key(i);if(k&&(k.indexOf("ph_")===0||k.indexOf("__ph_")===0))s.removeItem(k)}}catch(e){}}
function set(v){if(v!=="accept"&&v!=="reject")return;try{w.localStorage.setItem(K,v)}catch(e){}hide();try{w.dispatchEvent(new CustomEvent("0b-consent",{detail:v}))}catch(e){}if(v==="reject")clear()}
w.zbConsent={choice:choice,set:set,open:function(){show(true)},clear:clear};
d.addEventListener("click",function(e){var t=e.target&&e.target.closest?e.target.closest("[data-consent]"):null;if(!t)return;var a=t.getAttribute("data-consent");if(a==="open"){e.preventDefault();show(true)}else set(a)});
d.addEventListener("keydown",function(e){if(e.key==="Escape"&&el&&!el.hidden&&choice())hide()});
if(choice()===null){if(d.body)show(false);else d.addEventListener("DOMContentLoaded",function(){show(false)})}
})();`;

/** What PostHog may do before consent and after Reject: page views, cookieless. */
const ANONYMOUS = {
  cookieless_mode: "on_reject",
  // Consent not given yet counts as rejected, so PostHog counts page views cookieless instead of nothing.
  opt_out_capturing_by_default: true,
  autocapture: false,
  rageclick: false,
  capture_dead_clicks: false,
  enable_heatmaps: false,
  capture_pageleave: false,
  capture_exceptions: false,
  capture_performance: false,
  disable_session_recording: true,
  disable_surveys: true,
  person_profiles: "identified_only",
} as const;

/**
 * PostHog's init options for a surface and a choice. `cookieless_mode: "on_reject"` stays on
 * after Accept too, so a later Reject switches the same instance to cookieless.
 */
export function posthogOptions(surface: "site" | "dashboard", choice: ConsentChoice | null, apiHost: string): Record<string, unknown> {
  const base = { api_host: apiHost, ...(surface === "dashboard" ? { capture_pageview: "history_change" } : {}) };
  if (choice !== "accept") return { ...base, ...ANONYMOUS };
  const shared = {
    cookieless_mode: "on_reject",
    opt_out_capturing_by_default: false,
    capture_pageleave: true,
    disable_session_recording: true,
    person_profiles: "identified_only",
    capture_exceptions: true,
    capture_performance: { web_vitals: true, network_timing: false },
  };
  // The dashboard never autocaptures: its pages show decrypted secret values.
  return surface === "dashboard" ? { ...base, ...shared, autocapture: false } : { ...base, ...shared };
}

/** PostHog's own record of the opt-in (localStorage), cleared when the choice isn't Accept so it can't outvote ours. */
export const posthogConsentKey = (key: string) => `__ph_opt_in_out_${key}`;

