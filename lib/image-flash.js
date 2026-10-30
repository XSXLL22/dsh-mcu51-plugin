import { runImageAction } from './image.js'

/** Freeze the chosen logical code buffer into an immutable, hash-bound HEX. */
export function prepareImageFlash(args, dataDir) {
  const fail = (error, message) => ({ ok: false, error, message, hardwareAccess: false })
  if (args.hex !== undefined || args.project !== undefined) return fail('FLASH_SOURCE_CONFLICT', 'image与hex/project必须二选一。')
  if (typeof args.image !== 'string' || typeof args.expectedImageId !== 'string' || !/^[0-9a-f]{64}$/.test(args.expectedImageId)) {
    return fail('IMAGE_ID_REQUIRED', '冻结镜像烧录需要image绝对路径和完整expectedImageId。')
  }
  const image = runImageAction({ action: 'inspect', image: args.image, expectedImageId: args.expectedImageId }, dataDir)
  if (!image.ok) return image
  if (image.buffers.eeprom.dataBytes > 0) return fail('IMAGE_EEPROM_NOT_SUPPORTED', '镜像包含EEPROM数据，当前烧录入口未实现物理映射；不忽略该缓冲区。')
  if (image.buffers.code.startAddress?.type === 3) return fail('IMAGE_ENTRY_ISP_UNSUPPORTED', '随包ISP解析器尚不支持HEX03入口；仅可离线保存。')
  const exported = runImageAction({ action: 'export', image: args.image, expectedImageId: args.expectedImageId, buffer: 'code', format: 'hex' }, dataDir)
  if (!exported.ok) return exported
  return { ok: true, hardwareAccess: false, source: 'frozen-image', path: exported.path,
    imageBinding: { schemaVersion: 1, imageId: image.imageId, buffer: 'code', hexSha256: exported.sha256,
      denseSha256: exported.denseSha256, denseBytes: image.buffers.code.denseBytes }, exported }
}
