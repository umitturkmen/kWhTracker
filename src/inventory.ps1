$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Read-Class($name) {
    Get-CimInstance -ClassName $name -ErrorAction SilentlyContinue
}
function Capacity($bytes) {
    if ($bytes -gt 0) { (Format-Number ($bytes / 1GB)) + ' GiB' }
}
function Format-Number($value) { $value.ToString('0.##', [Globalization.CultureInfo]::InvariantCulture) }
function Rated($value, $unit) {
    if ($value -gt 0) { "$value $unit" }
}
function Component($group, $name, $fields) {
    $properties = @(
        foreach ($entry in $fields.GetEnumerator()) {
            if ($null -eq $entry.Value) { continue }
            $value = ([string]$entry.Value).Trim()
            if ($value -and $value -notin @('Default string', 'To Be Filled By O.E.M.', 'System Product Name')) {
                @{ label = [string]$entry.Key; value = $value }
            }
        }
    )
    if ($properties.Count) { @{ group = $group; name = $name; fields = $properties } }
}

$system = Read-Class Win32_ComputerSystem | Select-Object -First 1
$product = Read-Class Win32_ComputerSystemProduct | Select-Object -First 1
$os = Read-Class Win32_OperatingSystem | Select-Object -First 1
if (!$system -or !$os) { throw 'Windows hardware information is unavailable.' }

$gpuMemory = @{}
$nvidia = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if ($nvidia) {
    foreach ($line in (& $nvidia.Source --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null)) {
        if ($line -match '^(.+),\s*(\d+)\s*$') { $gpuMemory[$Matches[1].Trim()] = [long]$Matches[2] * 1MB }
    }
}

$sensors = Get-Item 'HKCU:\Software\FinalWire\AIDA64\SensorValues' -ErrorAction SilentlyContinue
$components = @(
    Component 'Sistem' 'İşletim sistemi' ([ordered]@{
        'Windows' = $os.Caption; 'Sürüm' = $os.Version; 'Derleme' = $os.BuildNumber; 'Mimari' = $os.OSArchitecture
    })
    Component 'Sistem' 'Bilgisayar' ([ordered]@{
        'Üretici' = $system.Manufacturer; 'Model' = $system.Model; 'Fiziksel bellek' = (Capacity $system.TotalPhysicalMemory)
    })
    Component 'DMI ve kasa' 'DMI sistem bilgisi' ([ordered]@{
        'Üretici' = $product.Vendor; 'Ürün adı' = $product.Name; 'Sürüm' = $product.Version
        'Seri numarası' = $product.IdentifyingNumber; 'Sistem UUID' = $product.UUID
    })
    foreach ($chassis in (Read-Class Win32_SystemEnclosure)) {
        $chassisNames = @{3='Masaustu';4='Alcak profilli masaustu';5='Pizza Box';6='Mini Tower';7='Tower';8='Tasinabilir';9='Dizustu';10='Notebook';13='All-in-one';15='Kucuk kasa';35='Mini PC'}
        $types = @($chassis.ChassisTypes | ForEach-Object { if ($chassisNames.ContainsKey([int]$_)) { $chassisNames[[int]$_] } else { [string]$_ } })
        Component 'DMI ve kasa' 'Kasa' ([ordered]@{
            'Tür' = $types -join ', '; 'Üretici' = $chassis.Manufacturer; 'Sürüm' = $chassis.Version
            'Seri numarası' = $chassis.SerialNumber; 'Varlık etiketi' = $chassis.SMBIOSAssetTag
        })
    }
    foreach ($cpu in (Read-Class Win32_Processor)) {
        Component 'İşlemci' $cpu.Name.Trim() ([ordered]@{
            'Üretici' = $cpu.Manufacturer; 'Çekirdek' = $cpu.NumberOfCores; 'Mantıksal işlemci' = $cpu.NumberOfLogicalProcessors
            'Azami saat' = (Rated $cpu.MaxClockSpeed 'MHz'); 'L2 önbellek' = (Rated $cpu.L2CacheSize 'KiB')
            'L3 önbellek' = (Rated $cpu.L3CacheSize 'KiB'); 'Soket' = $cpu.SocketDesignation
        })
    }
    foreach ($board in (Read-Class Win32_BaseBoard)) {
        Component 'Anakart ve BIOS' 'Anakart' ([ordered]@{
            'Üretici' = $board.Manufacturer; 'Model' = $board.Product; 'Revizyon' = $board.Version; 'Seri numarası' = $board.SerialNumber
        })
    }
    foreach ($bios in (Read-Class Win32_BIOS)) {
        Component 'Anakart ve BIOS' 'BIOS' ([ordered]@{
            'Üretici' = $bios.Manufacturer; 'Sürüm' = $bios.SMBIOSBIOSVersion
            'Yayın tarihi' = $(if ($bios.ReleaseDate) { $bios.ReleaseDate.ToString('yyyy-MM-dd') })
        })
    }
    foreach ($ram in (Read-Class Win32_PhysicalMemory)) {
        Component 'Bellek' $ram.DeviceLocator ([ordered]@{
            'Üretici' = $ram.Manufacturer; 'Parça numarası' = $ram.PartNumber; 'Kapasite' = (Capacity $ram.Capacity)
            'Veri hızı' = (Rated $ram.ConfiguredClockSpeed 'MT/s')
            'Bellek türü' = @{20='DDR';21='DDR2';24='DDR3';26='DDR4';34='DDR5';35='LPDDR5'}[[int]$ram.SMBIOSMemoryType]
        })
    }
    if ($sensors) {
        Component 'Bellek' 'AIDA64 bellek bilgisi' ([ordered]@{
            'Bellek hızı' = $sensors.GetValue('Value.SMEMSPEED')
            'Zamanlamalar' = $sensors.GetValue('Value.SMEMTIM')
        })
    }
    foreach ($gpu in (Read-Class Win32_VideoController)) {
        $vram = if ($gpuMemory.ContainsKey($gpu.Name)) { Capacity $gpuMemory[$gpu.Name] }
        Component 'Ekran' $gpu.Name ([ordered]@{
            'Video belleği' = $vram; 'Sürücü' = $gpu.DriverVersion; 'İşlemci' = $gpu.VideoProcessor
            'Çözünürlük' = $(if ($gpu.CurrentHorizontalResolution) { "$($gpu.CurrentHorizontalResolution) x $($gpu.CurrentVerticalResolution)" })
            'Yenileme hızı' = (Rated $gpu.CurrentRefreshRate 'Hz')
        })
    }
    foreach ($disk in (Read-Class Win32_DiskDrive)) {
        Component 'Depolama' $disk.Model ([ordered]@{
            'Kapasite' = (Capacity $disk.Size); 'Bağlantı' = $disk.InterfaceType
            'Firmware' = $disk.FirmwareRevision; 'Bölüm sayısı' = $disk.Partitions
        })
    }
    foreach ($volume in (Read-Class Win32_LogicalDisk | Where-Object { $_.DriveType -eq 3 -and $_.Size -gt 0 })) {
        Component 'Disk bölümleri' $volume.DeviceID ([ordered]@{
            'Dosya sistemi' = $volume.FileSystem; 'Kapasite' = (Capacity $volume.Size)
            'Boş alan' = $(if ($null -ne $volume.FreeSpace) { (Format-Number ($volume.FreeSpace / 1GB)) + ' GiB' })
            'Doluluk' = $(if ($null -ne $volume.FreeSpace) { (Format-Number (100 * (1 - $volume.FreeSpace / $volume.Size))) + '%' })
        })
    }
    foreach ($adapter in (Read-Class Win32_NetworkAdapter | Where-Object { $_.PhysicalAdapter -and $_.Manufacturer -ne 'Microsoft' })) {
        Component 'Çevre birimleri' $adapter.Name ([ordered]@{ 'Tür' = 'Ağ bağdaştırıcısı'; 'Üretici' = $adapter.Manufacturer })
    }
    foreach ($audio in (Read-Class Win32_SoundDevice)) {
        Component 'Çevre birimleri' $audio.Name ([ordered]@{ 'Tür' = 'Ses aygıtı'; 'Üretici' = $audio.Manufacturer })
    }
    foreach ($usb in (Read-Class Win32_PnPEntity | Where-Object { $_.Present -and $_.DeviceID -match '^(USB|USBSTOR)\\' } | Select-Object -First 64)) {
        Component 'USB' $usb.Name ([ordered]@{ 'Üretici' = $usb.Manufacturer; 'Sınıf' = $usb.PNPClass; 'Durum' = $usb.Status })
    }
)
ConvertTo-Json -InputObject $components -Depth 5 -Compress
