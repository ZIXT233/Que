import { extensionIconDataUrl } from "@/lib/harness/catalog";

const PROVIDER_ICONS: Record<string, { symbol: string; color: boolean }> = {
  anthropic: { symbol: "anthropic", color: false },
  openai: { symbol: "openai", color: false },
  "openai-codex": { symbol: "openai", color: false },
  google: { symbol: "google", color: true },
  "google-vertex": { symbol: "google", color: true },
  "ant-ling": { symbol: "antgroup", color: true },
  deepseek: { symbol: "deepseek", color: true },
  groq: { symbol: "groq", color: false },
  mistral: { symbol: "mistral", color: true },
  moonshotai: { symbol: "moonshot", color: false },
  "moonshotai-cn": { symbol: "moonshot", color: false },
  moonshot: { symbol: "moonshot", color: false },
  minimax: { symbol: "minimax", color: true },
  "minimax-cn": { symbol: "minimax", color: true },
  fireworks: { symbol: "fireworks", color: true },
  huggingface: { symbol: "huggingface", color: true },
  cerebras: { symbol: "cerebras", color: true },
  openrouter: { symbol: "openrouter", color: false },
  xai: { symbol: "xai", color: false },
  "cloudflare-ai-gateway": { symbol: "cloudflare", color: true },
  "cloudflare-workers-ai": { symbol: "cloudflare", color: true },
  "vercel-ai-gateway": { symbol: "vercel", color: false },
  "github-copilot": { symbol: "githubcopilot", color: false },
  "amazon-bedrock": { symbol: "aws", color: true },
  "azure-openai-responses": { symbol: "azure", color: true },
  "kimi-coding": { symbol: "kimi", color: true },
  nvidia: { symbol: "nvidia", color: true },
  opencode: { symbol: "opencode", color: true },
  "opencode-go": { symbol: "opencode", color: true },
  qwen: { symbol: "qwen", color: true },
  xiaomi: { symbol: "xiaomimimo", color: false },
  "xiaomi-token-plan-ams": { symbol: "xiaomimimo", color: false },
  "xiaomi-token-plan-cn": { symbol: "xiaomimimo", color: false },
  "xiaomi-token-plan-sgp": { symbol: "xiaomimimo", color: false },
  zai: { symbol: "zai", color: false },
  "zai-coding-cn": { symbol: "zai", color: false },
  zhipu: { symbol: "zhipu", color: true },
  cohere: { symbol: "cohere", color: true },
  perplexity: { symbol: "perplexity", color: true },
  together: { symbol: "together", color: true },
  grok: { symbol: "grok", color: false },
  cursor: { symbol: "cursor", color: false },
  codebuddy: { symbol: "codebuddy", color: true },
  claudecode: { symbol: "claudecode", color: true },
  omp: { symbol: "omp", color: true },
  antigravity: { symbol: "antigravity", color: true },
  pi: { symbol: "pi", color: true },
  devin: { symbol: "devin", color: false },
};

/**
 * Paint servers for sprite symbols that use url(#…) references. WebKit resolves
 * those references against the host document, not the external sprite file, so
 * the defs must exist in the page for gradients/filters to apply.
 */
const SPRITE_DEFS: Record<string, React.ReactNode> = {
  omp: (
    <linearGradient id="omp-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stopColor="oklch(0.7 0.24 340)" />
      <stop offset=".5" stopColor="oklch(0.62 0.21 295)" />
      <stop offset="1" stopColor="oklch(0.81 0.14 200)" />
    </linearGradient>
  ),
  antigravity: (
    <>
      <mask id="mask0_6001_463" style={{ maskType: "alpha" }} maskUnits="userSpaceOnUse" x={13} y={18} width={85} height={78}>
        <path d="M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z" fill="black" />
      </mask>
      <filter id="filter0_f_6001_463" x="2.49348" y="-26.5423" width="69.0899" height="61.2525" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="3.89034" result="effect1_foregroundBlur_6001_463" /></filter>
      <filter id="filter1_f_6001_463" x="28.7524" y="-32.0333" width="135.477" height="134.313" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="18.8078" result="effect1_foregroundBlur_6001_463" /></filter>
      <filter id="filter2_f_6001_463" x="-62.2884" y="-21.9253" width="142.637" height="127.18" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="15.9884" result="effect1_foregroundBlur_6001_463" /></filter>
      <filter id="filter3_f_6001_463" x="-62.2884" y="-21.9253" width="142.637" height="127.18" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="15.9884" result="effect1_foregroundBlur_6001_463" /></filter>
      <filter id="filter4_f_6001_463" x="-52.5697" y="-20.8346" width="127.582" height="127.452" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="15.9884" result="effect1_foregroundBlur_6001_463" /></filter>
      <filter id="filter5_f_6001_463" x="17.3619" y="45.4646" width="116.786" height="118.715" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="15.1937" result="effect1_foregroundBlur_6001_463" /></filter>
      <filter id="filter6_f_6001_463" x="-7.44765" y="-60.4737" width="125.303" height="122.858" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="13.7698" result="effect1_foregroundBlur_6001_463" /></filter>
      <filter id="filter7_f_6001_463" x="-27.7086" y="13.3597" width="157.119" height="162.029" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="12.297" result="effect1_foregroundBlur_6001_463" /></filter>
      <filter id="filter8_f_6001_463" x="50.4638" y="16.981" width="87.3973" height="83.7738" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="11.0036" result="effect1_foregroundBlur_6001_463" /></filter>
      <filter id="filter9_f_6001_463" x="34.2604" y="-28.457" width="116.701" height="104.506" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="9.29385" result="effect1_foregroundBlur_6001_463" /></filter>
      <filter id="filter10_f_6001_463" x="-15.1522" y="-15.9493" width="77.2941" height="91.076" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur stdDeviation="11.5027" result="effect1_foregroundBlur_6001_463" /></filter>
    </>
  ),
};

/** Inline paint-server defs for sprite symbols whose fills reference url(#…). */
export function SpritePaintDefs({ id }: { id: string }) {
  const content = SPRITE_DEFS[id];
  return content ? <defs>{content}</defs> : null;
}

export function ProviderIcon({ id, size, iconDataUrl }: { id: string; size: number; iconDataUrl?: string }) {
  const extensionIcon = iconDataUrl ?? extensionIconDataUrl(id);
  if (extensionIcon) {
    return <img aria-hidden="true" src={extensionIcon} width={size} height={size} style={{ width: size, height: size, objectFit: "contain", flexShrink: 0 }} />;
  }
  const icon = PROVIDER_ICONS[id];
  if (icon) {
    return (
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={icon.color ? undefined : "currentColor"}
        style={{ color: "var(--provider-icon-ink, var(--text-muted))", flexShrink: 0 }}
      >
        <SpritePaintDefs id={icon.symbol} />
        <use href={`/provider-icons.svg#${icon.symbol}`} />
      </svg>
    );
  }

  const label = id
    .split(/[-_]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        border: "1px solid var(--border)",
        borderRadius: 4,
        color: "var(--text-dim)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        fontSize: Math.max(8, Math.floor(size * 0.42)),
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {label}
    </span>
  );
}
