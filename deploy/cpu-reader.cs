using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using LibreHardwareMonitor.Hardware;

internal static class CpuReader
{
    private static float? Find(IHardware cpu, SensorType type, params string[] names)
    {
        foreach (string name in names)
        {
            ISensor sensor = cpu.Sensors.FirstOrDefault(item => item.SensorType == type && item.Name == name);
            if (sensor != null && sensor.Value.HasValue)
                return sensor.Value;
        }
        return null;
    }

    private static int Main(string[] args)
    {
        try
        {
            Run(args);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static void Run(string[] args)
    {
        string output = args[0];
        var computer = new Computer { IsCpuEnabled = true };
        computer.Open();
        try
        {
            IHardware cpu = computer.Hardware.FirstOrDefault(item => item.HardwareType == HardwareType.Cpu);
            if (cpu == null)
                throw new InvalidOperationException("CPU sensor unavailable.");

            do
            {
                cpu.Update();
                Thread.Sleep(1100);
                cpu.Update();
                float? watts = Find(cpu, SensorType.Power, "Package", "CPU Package");
                float? temperature = Find(cpu, SensorType.Temperature, "Core (Tctl/Tdie)", "Core (Tdie)", "Core (Tctl)", "CPU Package");
                if (!watts.HasValue || float.IsNaN(watts.Value) || watts.Value <= 0 || watts.Value > 1000)
                    throw new InvalidOperationException("CPU package power unavailable. Check the PawnIO driver.");

                string json = String.Format(CultureInfo.InvariantCulture,
                    "{{\"time\":{0},\"watts\":{1:F3},\"temperature\":{2}}}",
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), watts.Value,
                    temperature.HasValue && !float.IsNaN(temperature.Value) && !float.IsInfinity(temperature.Value)
                        ? temperature.Value.ToString("F1", CultureInfo.InvariantCulture) : "null");
                string temporary = output + ".tmp";
                File.WriteAllText(temporary, json);
                if (File.Exists(output)) File.Replace(temporary, output, null);
                else File.Move(temporary, output);
                if (args.Length > 1 && args[1] == "--once")
                    return;
                Thread.Sleep(15000);
            } while (true);
        }
        finally
        {
            computer.Close();
        }
    }
}
