import logo from "../../src-tauri/icons/source-desktop.svg";

export function QueLogo({ className, alt = "" }: { className?: string; alt?: string }) {
  return <img className={className} src={logo} alt={alt} />;
}

export function QueMark({ size = 24 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4" transform="translate(.13 .28)" stroke="#7f4433" strokeWidth="1.92" opacity=".48" />
    <path d="m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4" transform="translate(-.14 -.22)" stroke="#f4c7b1" strokeWidth="1.82" opacity=".9" />
    <path d="m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4" stroke="#ab6549" strokeWidth="1.65" />
  </svg>;
}
