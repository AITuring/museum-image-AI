declare module "utif" {
  type Ifd = Record<string, unknown> & {
    width?: number
    height?: number
    t256?: number | number[]
    t257?: number | number[]
  }

  export function decode(buffer: ArrayBuffer): Ifd[]
  export function decodeImage(buffer: ArrayBuffer, ifd: Ifd, ifds?: Ifd[]): void
  export function toRGBA8(ifd: Ifd): Uint8Array
}
