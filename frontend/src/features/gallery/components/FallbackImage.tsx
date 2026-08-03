import { useState, type ImgHTMLAttributes } from "react"

export function FallbackImage({
  src,
  fallbackSrc,
  onError,
  srcSet,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { src: string; fallbackSrc?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const currentSrc = failedSrc === src && fallbackSrc ? fallbackSrc : src

  return (
    <img
      {...props}
      src={currentSrc}
      srcSet={currentSrc === fallbackSrc ? undefined : srcSet}
      onError={(event) => {
        onError?.(event)
        if (fallbackSrc && currentSrc !== fallbackSrc) {
          setFailedSrc(src)
        }
      }}
    />
  )
}
