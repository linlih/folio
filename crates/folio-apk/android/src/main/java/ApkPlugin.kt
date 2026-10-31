package dev.folio.apk

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.webkit.WebView
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Its own class: the app already declares androidx's FileProvider, and
 *  the manifest can hold each provider class only once. */
class ApkFileProvider : FileProvider()

@InvokeArg
class InstallArgs {
    lateinit var path: String
}

@InvokeArg
class TextArgs {
    lateinit var text: String
}

@InvokeArg
class SealedArgs {
    lateinit var sealed: String
}

/** The Keystore key that seals the sync key. */
private const val SEAL_ALIAS = "folio-sync-key"

/** Downloaded update packages and the system installer, text other apps
 *  share to Folio, and the sealed sync key (lib.rs says why). */
@TauriPlugin
class ApkPlugin(private val activity: Activity) : Plugin(activity) {
    private fun dir(): File = File(activity.cacheDir, "updates")

    /** Shared text the page has not taken yet. */
    private var shared: String? = null

    /** A package from an earlier run is either installed by now or abandoned. */
    override fun load(webView: WebView) {
        dir().listFiles()?.forEach { it.delete() }
        // Opened from another app's share sheet.
        receive(activity.intent)
    }

    /** Shared to while already running. */
    override fun onNewIntent(intent: Intent) {
        receive(intent)
    }

    /** Keeps the text of a share (its subject first when the text lacks it,
     *  as some apps put the page title there), once: the intent is changed
     *  so that recreating the activity does not share it again. */
    private fun receive(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND || intent.type?.startsWith("text/") != true) return
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim().orEmpty()
        val both = if (subject.isNotEmpty() && !text.contains(subject)) "$subject\n$text" else text
        if (both.isNotBlank()) shared = both
        intent.action = Intent.ACTION_MAIN
    }

    @Command
    fun takeShared(invoke: Invoke) {
        val ret = JSObject()
        ret.put("text", shared)
        shared = null
        invoke.resolve(ret)
    }

    /** Back on a page with nowhere to go back to: out of sight, as the
     *  Home button would, rather than closed. */
    @Command
    fun toBackground(invoke: Invoke) {
        activity.moveTaskToBack(true)
        invoke.resolve()
    }

    /** This app's AES key in the Android Keystore, made the first time. The
     *  key itself never leaves the Keystore. */
    private fun sealKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(SEAL_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(SEAL_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    /** AES-GCM under the Keystore key: the 12-byte nonce, then the
     *  ciphertext and tag, base64. */
    @Command
    fun seal(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(TextArgs::class.java)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, sealKey())
            val out = cipher.iv + cipher.doFinal(args.text.toByteArray(Charsets.UTF_8))
            val ret = JSObject()
            ret.put("sealed", Base64.encodeToString(out, Base64.NO_WRAP))
            invoke.resolve(ret)
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: ex.toString())
        }
    }

    @Command
    fun open(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SealedArgs::class.java)
            val bytes = Base64.decode(args.sealed, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, sealKey(), GCMParameterSpec(128, bytes, 0, 12))
            val ret = JSObject()
            ret.put("text", String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8))
            invoke.resolve(ret)
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: ex.toString())
        }
    }

    @Command
    fun updatesDir(invoke: Invoke) {
        val updates = dir()
        updates.mkdirs()
        val ret = JSObject()
        ret.put("path", updates.absolutePath)
        invoke.resolve(ret)
    }

    @Command
    fun install(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(InstallArgs::class.java)
            val file = File(args.path)
            if (file.parentFile?.canonicalPath != dir().canonicalPath) {
                invoke.reject("not a downloaded update")
                return
            }
            val ret = JSObject()
            // Android 8+ asks the user once to let this app install packages.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
                val allow = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName))
                activity.startActivity(allow)
                ret.put("started", false)
                invoke.resolve(ret)
                return
            }
            val uri = FileProvider.getUriForFile(activity, activity.packageName + ".folio.apk", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            ret.put("started", true)
            invoke.resolve(ret)
        } catch (ex: Exception) {
            invoke.reject(ex.message)
        }
    }
}
