/**
 * Minimal ambient WebGPU surface — only the members the WebGPUBackend uses.
 * Kept local so the package is self-contained (no @webgpu/types dependency).
 * Descriptors are intentionally loose (`Record`/`unknown`) where the exact shape
 * doesn't affect our type-safety; the backend passes through native descriptors.
 */

interface GPUSupportedFeatures {
  has(feature: string): boolean;
}

interface GPUBuffer {
  destroy(): void;
}
interface GPUTexture {
  createView(desc?: Record<string, unknown>): GPUTextureView;
  destroy(): void;
}
interface GPUTextureView {
  readonly __brand?: 'view';
}
interface GPUSampler {
  readonly __brand?: 'sampler';
}
interface GPUShaderModule {
  readonly __brand?: 'shader';
}
interface GPUBindGroupLayout {
  readonly __brand?: 'bgl';
}
interface GPUPipelineLayout {
  readonly __brand?: 'pl';
}
interface GPURenderPipeline {
  getBindGroupLayout(index: number): GPUBindGroupLayout;
}
interface GPUBindGroup {
  readonly __brand?: 'bg';
}

interface GPURenderPassEncoder {
  setPipeline(pipeline: GPURenderPipeline): void;
  setBindGroup(index: number, group: GPUBindGroup): void;
  setVertexBuffer(slot: number, buffer: GPUBuffer, offset?: number): void;
  setIndexBuffer(buffer: GPUBuffer, format: string, offset?: number): void;
  setViewport(x: number, y: number, w: number, h: number, minDepth: number, maxDepth: number): void;
  setScissorRect(x: number, y: number, w: number, h: number): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number): void;
  drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number): void;
  end(): void;
}

interface GPUCommandEncoder {
  beginRenderPass(desc: Record<string, unknown>): GPURenderPassEncoder;
  finish(): GPUCommandBuffer;
}
interface GPUCommandBuffer {
  readonly __brand?: 'cmd';
}

interface GPUQueue {
  writeBuffer(buffer: GPUBuffer, offset: number, data: ArrayBufferView | ArrayBuffer, dataOffset?: number, size?: number): void;
  writeTexture(dest: Record<string, unknown>, data: ArrayBufferView | ArrayBuffer, layout: Record<string, unknown>, size: Record<string, unknown>): void;
  copyExternalImageToTexture(source: Record<string, unknown>, dest: Record<string, unknown>, size: Record<string, unknown>): void;
  submit(buffers: GPUCommandBuffer[]): void;
}

interface GPUDevice {
  readonly features: GPUSupportedFeatures;
  readonly queue: GPUQueue;
  createBuffer(desc: Record<string, unknown>): GPUBuffer;
  createTexture(desc: Record<string, unknown>): GPUTexture;
  createSampler(desc: Record<string, unknown>): GPUSampler;
  createShaderModule(desc: Record<string, unknown>): GPUShaderModule;
  createBindGroupLayout(desc: Record<string, unknown>): GPUBindGroupLayout;
  createPipelineLayout(desc: Record<string, unknown>): GPUPipelineLayout;
  createRenderPipeline(desc: Record<string, unknown>): GPURenderPipeline;
  createBindGroup(desc: Record<string, unknown>): GPUBindGroup;
  createCommandEncoder(desc?: Record<string, unknown>): GPUCommandEncoder;
  destroy(): void;
}

interface GPUAdapter {
  requestDevice(desc?: Record<string, unknown>): Promise<GPUDevice>;
}

interface GPUCanvasContext {
  configure(desc: Record<string, unknown>): void;
  getCurrentTexture(): GPUTexture;
}

interface GPU {
  requestAdapter(options?: Record<string, unknown>): Promise<GPUAdapter | null>;
  getPreferredCanvasFormat(): string;
}

interface Navigator {
  readonly gpu?: GPU;
}
