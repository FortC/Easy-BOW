// ort-fast = onnxruntime-web 精确版本别名安装（与 transformers 4.3.1 配套）。
// 其自带的 types.d.ts 不是合法模块（TS2306），按 any 使用（运行时已实测）。
declare module 'ort-fast' {
  export const env: any
  export const InferenceSession: any
  export const Tensor: any
  const ort: any
  export default ort
}
