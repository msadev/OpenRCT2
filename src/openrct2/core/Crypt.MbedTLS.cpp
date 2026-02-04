/*****************************************************************************
 * Copyright (c) 2014-2026 OpenRCT2 developers
 *
 * For a complete list of all authors, please refer to contributors.md
 * Interested in contributing? Visit https://github.com/OpenRCT2/OpenRCT2
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#if !defined(DISABLE_NETWORK) && defined(__EMSCRIPTEN__)

    #include "Crypt.h"

    #include <mbedtls/ctr_drbg.h>
    #include <mbedtls/entropy.h>
    #include <mbedtls/pk.h>
    #include <mbedtls/rsa.h>
    #include <mbedtls/sha1.h>
    #include <mbedtls/sha256.h>

    #include <mutex>
    #include <stdexcept>
    #include <string>
    #include <vector>

using namespace OpenRCT2::Crypt;

namespace
{
    std::once_flag gRngInitFlag;
    mbedtls_entropy_context gEntropy;
    mbedtls_ctr_drbg_context gCtrDrbg;

    void InitRng()
    {
        mbedtls_entropy_init(&gEntropy);
        mbedtls_ctr_drbg_init(&gCtrDrbg);
        const char* pers = "openrct2";
        int ret = mbedtls_ctr_drbg_seed(&gCtrDrbg, mbedtls_entropy_func, &gEntropy,
            reinterpret_cast<const unsigned char*>(pers), std::strlen(pers));
        if (ret != 0)
        {
            throw std::runtime_error("mbedtls_ctr_drbg_seed failed");
        }
    }

    mbedtls_ctr_drbg_context* GetRng()
    {
        std::call_once(gRngInitFlag, InitRng);
        return &gCtrDrbg;
    }

    void Sha256(const void* data, size_t len, unsigned char out[32])
    {
        int ret = mbedtls_sha256_ret(static_cast<const unsigned char*>(data), len, out, 0);
        if (ret != 0)
        {
            throw std::runtime_error("mbedtls_sha256_ret failed");
        }
    }
} // namespace

class MbedTLSSha1Algorithm final : public Sha1Algorithm
{
private:
    mbedtls_sha1_context _ctx{};

public:
    MbedTLSSha1Algorithm()
    {
        mbedtls_sha1_init(&_ctx);
        mbedtls_sha1_starts_ret(&_ctx);
    }
    ~MbedTLSSha1Algorithm() override
    {
        mbedtls_sha1_free(&_ctx);
    }

    HashAlgorithm* Clear() override
    {
        mbedtls_sha1_free(&_ctx);
        mbedtls_sha1_init(&_ctx);
        mbedtls_sha1_starts_ret(&_ctx);
        return this;
    }

    HashAlgorithm* Update(const void* data, size_t dataLen) override
    {
        if (dataLen > 0)
        {
            mbedtls_sha1_update_ret(&_ctx, static_cast<const unsigned char*>(data), dataLen);
        }
        return this;
    }

    Result Finish() override
    {
        Result res{};
        mbedtls_sha1_finish_ret(&_ctx, res.data());
        return res;
    }
};

class MbedTLSSha256Algorithm final : public Sha256Algorithm
{
private:
    mbedtls_sha256_context _ctx{};

public:
    MbedTLSSha256Algorithm()
    {
        mbedtls_sha256_init(&_ctx);
        mbedtls_sha256_starts_ret(&_ctx, 0);
    }
    ~MbedTLSSha256Algorithm() override
    {
        mbedtls_sha256_free(&_ctx);
    }

    HashAlgorithm* Clear() override
    {
        mbedtls_sha256_free(&_ctx);
        mbedtls_sha256_init(&_ctx);
        mbedtls_sha256_starts_ret(&_ctx, 0);
        return this;
    }

    HashAlgorithm* Update(const void* data, size_t dataLen) override
    {
        if (dataLen > 0)
        {
            mbedtls_sha256_update_ret(&_ctx, static_cast<const unsigned char*>(data), dataLen);
        }
        return this;
    }

    Result Finish() override
    {
        Result res{};
        mbedtls_sha256_finish_ret(&_ctx, res.data());
        return res;
    }
};

class MbedTLSRsaKey final : public RsaKey
{
private:
    mbedtls_pk_context _pk{};

    void EnsureKey()
    {
        if (_pk.pk_info == nullptr)
        {
            throw std::runtime_error("No key loaded");
        }
    }

public:
    MbedTLSRsaKey()
    {
        mbedtls_pk_init(&_pk);
    }
    ~MbedTLSRsaKey() override
    {
        mbedtls_pk_free(&_pk);
    }

    void Generate() override
    {
        mbedtls_pk_free(&_pk);
        mbedtls_pk_init(&_pk);
        int ret = mbedtls_pk_setup(&_pk, mbedtls_pk_info_from_type(MBEDTLS_PK_RSA));
        if (ret != 0)
        {
            throw std::runtime_error("mbedtls_pk_setup failed");
        }

        auto* rsa = mbedtls_pk_rsa(_pk);
        ret = mbedtls_rsa_gen_key(rsa, mbedtls_ctr_drbg_random, GetRng(), 2048, 65537);
        if (ret != 0)
        {
            throw std::runtime_error("mbedtls_rsa_gen_key failed");
        }
    }

    void SetPrivate(std::string_view pem) override
    {
        mbedtls_pk_free(&_pk);
        mbedtls_pk_init(&_pk);
        std::string buf(pem);
        if (buf.empty() || buf.back() != '\0')
        {
            buf.push_back('\0');
        }
        int ret = mbedtls_pk_parse_key(&_pk, reinterpret_cast<const unsigned char*>(buf.data()), buf.size(), nullptr, 0);
        if (ret != 0)
        {
            throw std::runtime_error("mbedtls_pk_parse_key failed");
        }
    }

    void SetPublic(std::string_view pem) override
    {
        mbedtls_pk_free(&_pk);
        mbedtls_pk_init(&_pk);
        std::string buf(pem);
        if (buf.empty() || buf.back() != '\0')
        {
            buf.push_back('\0');
        }
        int ret = mbedtls_pk_parse_public_key(&_pk, reinterpret_cast<const unsigned char*>(buf.data()), buf.size());
        if (ret != 0)
        {
            throw std::runtime_error("mbedtls_pk_parse_public_key failed");
        }
    }

    std::string GetPrivate() override
    {
        EnsureKey();
        std::vector<unsigned char> buf(16384);
        int ret = mbedtls_pk_write_key_pem(&_pk, buf.data(), buf.size());
        if (ret != 0)
        {
            throw std::runtime_error("mbedtls_pk_write_key_pem failed");
        }
        return std::string(reinterpret_cast<char*>(buf.data()));
    }

    std::string GetPublic() override
    {
        EnsureKey();
        std::vector<unsigned char> buf(8192);
        int ret = mbedtls_pk_write_pubkey_pem(&_pk, buf.data(), buf.size());
        if (ret != 0)
        {
            throw std::runtime_error("mbedtls_pk_write_pubkey_pem failed");
        }
        return std::string(reinterpret_cast<char*>(buf.data()));
    }

    const mbedtls_pk_context& GetPk() const
    {
        return _pk;
    }

    mbedtls_pk_context& GetPk()
    {
        return _pk;
    }
};

class MbedTLSRsaAlgorithm final : public RsaAlgorithm
{
public:
    std::vector<uint8_t> SignData(const RsaKey& key, const void* data, size_t dataLen) override
    {
        auto& k = static_cast<const MbedTLSRsaKey&>(key);
        unsigned char hash[32]{};
        Sha256(data, dataLen, hash);

        size_t sigLen = 0;
        const size_t maxLen = mbedtls_pk_get_len(&k.GetPk());
        std::vector<uint8_t> sig(maxLen);
        int ret = mbedtls_pk_sign(&const_cast<MbedTLSRsaKey&>(k).GetPk(), MBEDTLS_MD_SHA256, hash, sizeof(hash), sig.data(), &sigLen,
            mbedtls_ctr_drbg_random, GetRng());
        if (ret != 0)
        {
            throw std::runtime_error("mbedtls_pk_sign failed");
        }
        sig.resize(sigLen);
        return sig;
    }

    bool VerifyData(const RsaKey& key, const void* data, size_t dataLen, const void* sig, size_t sigLen) override
    {
        auto& k = static_cast<const MbedTLSRsaKey&>(key);
        unsigned char hash[32]{};
        Sha256(data, dataLen, hash);
        int ret = mbedtls_pk_verify(&const_cast<MbedTLSRsaKey&>(k).GetPk(), MBEDTLS_MD_SHA256, hash, sizeof(hash),
            static_cast<const unsigned char*>(sig), sigLen);
        return ret == 0;
    }
};

namespace OpenRCT2::Crypt
{
    std::unique_ptr<Sha1Algorithm> CreateSHA1()
    {
        return std::make_unique<MbedTLSSha1Algorithm>();
    }

    std::unique_ptr<Sha256Algorithm> CreateSHA256()
    {
        return std::make_unique<MbedTLSSha256Algorithm>();
    }

    std::unique_ptr<RsaAlgorithm> CreateRSA()
    {
        return std::make_unique<MbedTLSRsaAlgorithm>();
    }

    std::unique_ptr<RsaKey> CreateRSAKey()
    {
        return std::make_unique<MbedTLSRsaKey>();
    }
} // namespace OpenRCT2::Crypt

#endif // !DISABLE_NETWORK && __EMSCRIPTEN__
