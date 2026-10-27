/** Matchframe Esports mark (assets/brand). Decorative next to the word, which carries the name. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return <img className="logo-mark" src="/brand/mark.webp" width={size} height={size} alt="" aria-hidden="true" />;
}

export function Logo() {
  return (
    <span className="logo">
      <LogoMark />
      <span className="logo-word">
        Match<span>frame</span>
      </span>
    </span>
  );
}
