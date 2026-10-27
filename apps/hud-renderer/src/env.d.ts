/// <reference types="vite/client" />

declare module "*.svg?react" {
  import type { ComponentType, SVGProps } from "react";
  const Svg: ComponentType<SVGProps<SVGSVGElement>>;
  export default Svg;
}
