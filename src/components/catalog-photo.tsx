import Image, { type ImageProps } from "next/image";
import { storefrontPath } from "@/config/storefront-path";
import { catalogMediaPath, catalogMediaSizes } from "@/lib/catalog/media-size";
import type { CatalogImage } from "@/lib/catalog/types";

type PhotoProps = Pick<ImageProps, "fill" | "width" | "height" | "sizes" | "loading" | "fetchPriority"> & {
  image: CatalogImage;
  responsive?: boolean;
  rendition: keyof typeof catalogMediaSizes;
};

export function CatalogPhoto({ image, responsive, rendition, fill, ...props }: PhotoProps) {
  const src = storefrontPath(image.src);
  if (!responsive || !catalogMediaPath.test(image.src)) {
    return <Image src={src} alt={image.alt} fill={fill} {...props} />;
  }
  const widths = catalogMediaSizes[rendition];
  const source = (width: number) => src + "?w=" + width;
  // Staging disables Next's optimizer to preserve access checks. Use the bounded media route directly.
  // eslint-disable-next-line @next/next/no-img-element
  return <img alt={image.alt} {...props} src={source(widths[0])}
    srcSet={widths.length > 1 ? widths.map(width => `${source(width)} ${width}w`).join(", ") : undefined}
    decoding="async" loading={props.loading ?? "lazy"}
    style={fill ? { position: "absolute", inset: 0, width: "100%", height: "100%" } : undefined} />;
}
