using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace TeXChronicle.Portable
{
    internal sealed class LauncherForm : Form
    {
        private static readonly Regex WorkspaceUrl = new Regex(
            @"http://127\.0\.0\.1:\d+/app",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        private readonly string[] launchArgs;
        private readonly Label statusLabel;
        private readonly TextBox logBox;
        private readonly Button openButton;
        private readonly NotifyIcon trayIcon;
        private Process child;
        private string workspaceUrl;
        private bool closing;
        private bool workspaceOpened;

        internal LauncherForm(string[] args)
        {
            launchArgs = args ?? new string[0];
            Text = "TeXChronicle";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(720, 390);
            MinimumSize = new Size(560, 300);
            Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            Icon = SystemIcons.Application;

            var header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = 76;
            header.Padding = new Padding(18, 13, 18, 8);

            var heading = new Label();
            heading.AutoSize = true;
            heading.Font = new Font("Segoe UI Semibold", 16F, FontStyle.Bold, GraphicsUnit.Point);
            heading.Text = "TeXChronicle";
            heading.Location = new Point(16, 10);
            header.Controls.Add(heading);

            statusLabel = new Label();
            statusLabel.AutoSize = true;
            statusLabel.ForeColor = Color.DimGray;
            statusLabel.Text = "Starting the portable workspace…";
            statusLabel.Location = new Point(19, 48);
            header.Controls.Add(statusLabel);
            Controls.Add(header);

            var footer = new Panel();
            footer.Dock = DockStyle.Bottom;
            footer.Height = 56;
            footer.Padding = new Padding(14, 10, 14, 10);

            openButton = new Button();
            openButton.Text = "Open workspace";
            openButton.Enabled = false;
            openButton.Size = new Size(126, 32);
            openButton.Location = new Point(14, 11);
            openButton.Click += delegate { OpenWorkspace(); };
            footer.Controls.Add(openButton);

            var stopButton = new Button();
            stopButton.Text = "Stop TeXChronicle";
            stopButton.Size = new Size(118, 32);
            stopButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            stopButton.Location = new Point(ClientSize.Width - stopButton.Width - 14, 11);
            stopButton.Click += delegate { Close(); };
            footer.Controls.Add(stopButton);
            Controls.Add(footer);

            logBox = new TextBox();
            logBox.Dock = DockStyle.Fill;
            logBox.Multiline = true;
            logBox.ReadOnly = true;
            logBox.ScrollBars = ScrollBars.Vertical;
            logBox.BackColor = Color.FromArgb(28, 30, 34);
            logBox.ForeColor = Color.Gainsboro;
            logBox.BorderStyle = BorderStyle.None;
            logBox.Font = new Font("Consolas", 9F, FontStyle.Regular, GraphicsUnit.Point);
            logBox.Margin = new Padding(14);
            Controls.Add(logBox);
            logBox.BringToFront();

            var trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("Open workspace", null, delegate { OpenWorkspace(); });
            trayMenu.Items.Add("Show status", null, delegate { ShowStatus(); });
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add("Stop and exit", null, delegate { Close(); });

            trayIcon = new NotifyIcon();
            trayIcon.Icon = SystemIcons.Application;
            trayIcon.Text = "TeXChronicle portable";
            trayIcon.ContextMenuStrip = trayMenu;
            trayIcon.Visible = true;
            trayIcon.DoubleClick += delegate { OpenWorkspace(); };

            Shown += delegate { BeginInvoke((MethodInvoker)StartPortable); };
            FormClosing += OnFormClosing;
        }

        private string PortableRoot
        {
            get { return Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory); }
        }

        private void StartPortable()
        {
            try
            {
                var root = PortableRoot;
                var node = Path.Combine(root, "runtime", "node.exe");
                var cli = Path.Combine(root, "app", "bin", "cli.mjs");
                var browser = Path.Combine(root, "resources", "playwright");
                var assets = Path.Combine(root, "resources", "busytex");
                var git = Path.Combine(root, "resources", "git", "cmd");

                RequireFile(node, "portable Node runtime");
                RequireFile(cli, "TeXChronicle application");
                RequireDirectory(browser, "portable browser runtime");
                RequireFile(Path.Combine(assets, "busytex.wasm"), "portable TeX engine");
                RequireFile(Path.Combine(git, "git.exe"), "portable Git runtime");

                string mode;
                string main = null;
                string workingDirectory;
                if (launchArgs.Length > 0)
                {
                    main = Path.GetFullPath(launchArgs[0]);
                    if (!File.Exists(main) || !main.EndsWith(".tex", StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("Drop a real .tex file onto TeXChronicle.exe, or run it without arguments to choose a recent project.");
                    mode = "preview";
                    workingDirectory = Path.GetDirectoryName(main);
                }
                else
                {
                    mode = "open";
                    workingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                    if (String.IsNullOrEmpty(workingDirectory) || !Directory.Exists(workingDirectory))
                        workingDirectory = root;
                }

                var arguments = Quote(cli) + " " + mode;
                if (main != null) arguments += " " + Quote(main);
                arguments += " --no-open";

                var start = new ProcessStartInfo();
                start.FileName = node;
                start.Arguments = arguments;
                start.WorkingDirectory = workingDirectory;
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardInput = true;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                start.StandardOutputEncoding = Encoding.UTF8;
                start.StandardErrorEncoding = Encoding.UTF8;
                start.EnvironmentVariables["TEXCHRONICLE_PORTABLE_ROOT"] = root;
                start.EnvironmentVariables["TEXCHRONICLE_ASSETS_DIR"] = assets;
                start.EnvironmentVariables["PLAYWRIGHT_BROWSERS_PATH"] = browser;
                start.EnvironmentVariables["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"] = "1";
                start.EnvironmentVariables["PLAYWRIGHT_SKIP_BROWSER_GC"] = "1";
                start.EnvironmentVariables["PATH"] = git + ";" + Path.Combine(root, "runtime") + ";" + (start.EnvironmentVariables["PATH"] ?? "");

                child = new Process();
                child.StartInfo = start;
                child.EnableRaisingEvents = true;
                child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs) { HandleLine(eventArgs.Data, false); };
                child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs) { HandleLine(eventArgs.Data, true); };
                child.Exited += delegate { HandleExit(); };
                if (!child.Start()) throw new InvalidOperationException("The portable TeXChronicle process did not start.");
                child.BeginOutputReadLine();
                child.BeginErrorReadLine();
                statusLabel.Text = launchArgs.Length > 0 ? "Opening the selected LaTeX paper…" : "Choose a recent paper or browse for its main .tex file.";
            }
            catch (Exception error)
            {
                Fail(error.Message);
            }
        }

        private static void RequireFile(string path, string label)
        {
            if (!File.Exists(path)) throw new FileNotFoundException("The " + label + " is missing from the portable package.", path);
        }

        private static void RequireDirectory(string path, string label)
        {
            if (!Directory.Exists(path)) throw new DirectoryNotFoundException("The " + label + " is missing from the portable package: " + path);
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private void HandleLine(string line, bool error)
        {
            if (line == null) return;
            if (!IsDisposed && IsHandleCreated)
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    logBox.AppendText((error ? "[engine] " : "") + line + Environment.NewLine);
                    var match = WorkspaceUrl.Match(line);
                    if (match.Success) WorkspaceReady(match.Value);
                });
            }
        }

        private void WorkspaceReady(string url)
        {
            workspaceUrl = url;
            statusLabel.Text = "Running — your project history remains beside the paper.";
            statusLabel.ForeColor = Color.FromArgb(30, 112, 66);
            openButton.Enabled = true;
            trayIcon.Text = "TeXChronicle is running";
            if (!workspaceOpened)
            {
                workspaceOpened = true;
                OpenWorkspace();
                var timer = new Timer();
                timer.Interval = 900;
                timer.Tick += delegate
                {
                    timer.Stop();
                    timer.Dispose();
                    if (!closing && WindowState != FormWindowState.Minimized) WindowState = FormWindowState.Minimized;
                };
                timer.Start();
            }
        }

        private void OpenWorkspace()
        {
            if (String.IsNullOrEmpty(workspaceUrl))
            {
                ShowStatus();
                return;
            }
            try
            {
                Process.Start(new ProcessStartInfo(workspaceUrl) { UseShellExecute = true });
            }
            catch (Exception error)
            {
                ShowStatus();
                MessageBox.Show(this, error.Message, "Could not open the browser", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void ShowStatus()
        {
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
        }

        private void HandleExit()
        {
            if (closing || IsDisposed || !IsHandleCreated) return;
            int code;
            try { code = child.ExitCode; }
            catch { code = -1; }
            BeginInvoke((MethodInvoker)delegate
            {
                if (closing) return;
                if (code == 0 && !String.IsNullOrEmpty(workspaceUrl))
                {
                    // Another portable launcher already owns this project. It
                    // gave us its URL, so this short-lived helper can disappear.
                    closing = true;
                    trayIcon.Visible = false;
                    Close();
                    return;
                }
                statusLabel.Text = code == 0 ? "No project was selected." : "TeXChronicle stopped unexpectedly (exit " + code + ").";
                statusLabel.ForeColor = code == 0 ? Color.DimGray : Color.Firebrick;
                ShowStatus();
                if (code == 0)
                {
                    var timer = new Timer();
                    timer.Interval = 700;
                    timer.Tick += delegate { timer.Stop(); timer.Dispose(); closing = true; Close(); };
                    timer.Start();
                }
            });
        }

        private void Fail(string message)
        {
            statusLabel.Text = "Portable startup failed.";
            statusLabel.ForeColor = Color.Firebrick;
            logBox.AppendText(message + Environment.NewLine);
            MessageBox.Show(this, message, "TeXChronicle portable", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        private void OnFormClosing(object sender, FormClosingEventArgs eventArgs)
        {
            if (closing)
            {
                trayIcon.Visible = false;
                trayIcon.Dispose();
                return;
            }
            closing = true;
            statusLabel.Text = "Stopping TeXChronicle…";
            trayIcon.Visible = false;
            StopChild();
            trayIcon.Dispose();
        }

        private void StopChild()
        {
            if (child == null) return;
            try
            {
                if (child.HasExited) return;
                try { child.StandardInput.Close(); }
                catch { }
                if (child.WaitForExit(4000)) return;

                var kill = new ProcessStartInfo();
                kill.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe");
                kill.Arguments = "/PID " + child.Id + " /T /F";
                kill.UseShellExecute = false;
                kill.CreateNoWindow = true;
                using (var killer = Process.Start(kill))
                {
                    if (killer != null) killer.WaitForExit(3000);
                }
            }
            catch
            {
                try { if (!child.HasExited) child.Kill(); }
                catch { }
            }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LauncherForm(args));
        }
    }
}
