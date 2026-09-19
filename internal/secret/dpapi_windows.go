//go:build windows

package secret

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

// Windows DPAPI：用当前用户凭据加解密，密文只能在同一个 Windows 用户下解开。
// 不引入 golang.org/x/sys，直接按 Crypt32 的调用约定声明动态符号。
var (
	crypt32DLL        = syscall.NewLazyDLL("crypt32.dll")
	procProtectData   = crypt32DLL.NewProc("CryptProtectData")
	procUnprotectData = crypt32DLL.NewProc("CryptUnprotectData")
	kernel32DLL       = syscall.NewLazyDLL("kernel32.dll")
	procLocalFree     = kernel32DLL.NewProc("LocalFree")
)

// CRYPTPROTECT_UI_FORBIDDEN：绝不弹出任何 UI（服务/后台进程下必需）。
const cryptProtectUIForbidden = 0x1

// dataBlob 对应 Win32 DATA_BLOB。
type dataBlob struct {
	cbData uint32
	pbData *byte
}

// New 返回基于当前 Windows 用户的 DPAPI 实现。
func New() Store { return dpapiStore{} }

type dpapiStore struct{}

// Encrypt 用 DPAPI 加密明文，密文与当前用户绑定。
func (dpapiStore) Encrypt(plain string) ([]byte, error) {
	if plain == "" {
		// DPAPI 不接受零长度输入，这里给出明确原因而不是 Win32 的 ERROR_INVALID_PARAMETER。
		return nil, errors.New("明文不能为空")
	}
	in := blobOf([]byte(plain))
	var out dataBlob
	ret, _, callErr := procProtectData.Call(
		uintptr(unsafe.Pointer(in)),
		0, // szDataDescr
		0, // pOptionalEntropy
		0, // pvReserved
		0, // pPromptStruct
		cryptProtectUIForbidden,
		uintptr(unsafe.Pointer(&out)),
	)
	if ret == 0 {
		return nil, fmt.Errorf("加密失败: %w", callErr)
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
	return out.copyBytes(), nil
}

// Decrypt 解开 DPAPI 密文；换用户或数据损坏都会失败。
func (dpapiStore) Decrypt(cipher []byte) (string, error) {
	if len(cipher) == 0 {
		return "", errors.New("密文为空")
	}
	in := blobOf(cipher)
	var out dataBlob
	ret, _, callErr := procUnprotectData.Call(
		uintptr(unsafe.Pointer(in)),
		0, // ppszDataDescr，置 0 表示不申请描述串
		0, // pOptionalEntropy
		0, // pvReserved
		0, // pPromptStruct
		cryptProtectUIForbidden,
		uintptr(unsafe.Pointer(&out)),
	)
	if ret == 0 {
		return "", fmt.Errorf("解密失败: %w", callErr)
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
	return string(out.copyBytes()), nil
}

func blobOf(data []byte) *dataBlob {
	if len(data) == 0 {
		return &dataBlob{}
	}
	return &dataBlob{cbData: uint32(len(data)), pbData: &data[0]}
}

// copyBytes 复制 DPAPI 分配的内存，调用方随后必须 LocalFree。
func (b *dataBlob) copyBytes() []byte {
	if b.pbData == nil || b.cbData == 0 {
		return nil
	}
	out := make([]byte, b.cbData)
	copy(out, unsafe.Slice(b.pbData, b.cbData))
	return out
}
