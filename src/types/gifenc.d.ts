// Minimal typings for gifenc (the package ships plain JS).
declare module 'gifenc' {
  export interface QuantizeOptions {
    format?: 'rgb565' | 'rgb444' | 'rgba4444'
    oneBitAlpha?: boolean | number
    clearAlpha?: boolean
    clearAlphaThreshold?: number
    clearAlphaColor?: number
  }

  export interface WriteFrameOptions {
    palette?: number[][]
    delay?: number
    repeat?: number
    transparent?: boolean
    transparentIndex?: number
    dispose?: number
    first?: boolean
  }

  export interface GifEncoderInstance {
    writeFrame(index: Uint8Array, width: number, height: number, options?: WriteFrameOptions): void
    finish(): void
    bytes(): Uint8Array
    bytesView(): Uint8Array
    reset(): void
  }

  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): GifEncoderInstance
  export function quantize(rgba: Uint8ClampedArray | Uint8Array, maxColors: number, options?: QuantizeOptions): number[][]
  export function applyPalette(
    rgba: Uint8ClampedArray | Uint8Array,
    palette: number[][],
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array
}
