// Package secret 提供 API Key 的对称加解密。
//
// 实现必须把密钥绑定到当前 Windows 用户（DPAPI），密文只用于本机数据库，
// 平台不支持时 New 返回一个始终报错的实现。
package secret

// Store 只做对称加解密。
type Store interface {
	Encrypt(plain string) ([]byte, error)
	Decrypt(cipher []byte) (string, error)
}
