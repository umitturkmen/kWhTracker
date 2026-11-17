using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

internal static class AgentLauncher
{
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;

    private static int Main(string[] args)
    {
        if (args.Length != 1) return 87;

        // The job handle closes when Task Scheduler stops the launcher, ending its whole process tree.
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return Marshal.GetLastWin32Error();

        var limits = new ExtendedLimitInformation();
        limits.BasicLimits.LimitFlags = JobObjectLimitKillOnJobClose;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(limits)) ||
            !AssignProcessToJobObject(job, GetCurrentProcess()))
        {
            return Marshal.GetLastWin32Error();
        }

        var startInfo = new ProcessStartInfo(args[0], "--env-file=.env src/agent.mjs")
        {
            UseShellExecute = false,
            CreateNoWindow = true
        };

        try
        {
            using (var agent = Process.Start(startInfo))
            {
                agent.WaitForExit();
                return agent.ExitCode;
            }
        }
        catch (Win32Exception error)
        {
            return error.NativeErrorCode;
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass,
        ref ExtendedLimitInformation information, int length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimits;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
}
