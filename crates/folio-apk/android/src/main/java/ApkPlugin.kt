package dev.folio.apk

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.WebView
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

/** Its own class: the app already declares androidx's FileProvider, and
 *  the manifest can hold each provider class only once. */
class ApkFileProvider : FileProvider()

@InvokeArg
class InstallArgs {
    lateinit var path: String
}

/** Downloaded update packages and the system installer (lib.rs says why). */
@TauriPlugin
class ApkPlugin(private val activity: Activity) : Plugin(activity) {
    private fun dir(): File = File(activity.cacheDir, "updates")

    /** A package from an earlier run is either installed by now or abandoned. */
    override fun load(webView: WebView) {
        dir().listFiles()?.forEach { it.delete() }
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
