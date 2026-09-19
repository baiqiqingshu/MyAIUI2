//go:build !windows

package secret

import "errors"

var errUnsupported = errors.New("当前平台不支持密钥加密")

// New 在非 Windows 平台返回报错实现（原型只发布 Windows）。
func New() Store { return unsupportedStore{} }

type unsupportedStore struct{}

func (unsupportedStore) Encrypt(string) ([]byte, error) { return nil, errUnsupported }

func (unsupportedStore) Decrypt([]byte) (string, error) { return "", errUnsupported }
