$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$streamType = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$writerType = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType=WindowsRuntime]
$decoderType = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$bitmapType = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$transformType = [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$engineType = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$resultType = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
$languageType = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Length -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Wait-WinRtResult($operation, [Type] $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    $task.GetAwaiter().GetResult()
}

$languageTag = $env:CAREER_STUDIO_OCR_LANGUAGE
$engine = $engineType::TryCreateFromLanguage($languageType::new($languageTag))
if ($null -eq $engine) {
    [Console]::WriteLine('{"error":"language"}')
    exit
}

$image = [IO.MemoryStream]::new()
[Console]::OpenStandardInput().CopyTo($image)
$stream = $streamType::new()
$writer = $writerType::new($stream.GetOutputStreamAt(0))
try {
    $writer.WriteBytes($image.ToArray())
    $null = Wait-WinRtResult ($writer.StoreAsync()) ([uint32])
    $stream.Seek(0)
    $decoder = Wait-WinRtResult ($decoderType::CreateAsync($stream)) $decoderType
    $transform = $transformType::new()
    $scale = [Math]::Min(1, $engineType::MaxImageDimension / [Math]::Max($decoder.PixelWidth, $decoder.PixelHeight))
    $transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Floor($decoder.PixelWidth * $scale))
    $transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor($decoder.PixelHeight * $scale))
    $bitmap = Wait-WinRtResult ($decoder.GetSoftwareBitmapAsync('Bgra8', 'Premultiplied', $transform, 'RespectExifOrientation', 'DoNotColorManage')) $bitmapType
    try {
        $result = Wait-WinRtResult ($engine.RecognizeAsync($bitmap)) $resultType
        $text = ($result.Lines | ForEach-Object { $_.Text }) -join "`n"
        [Console]::WriteLine((ConvertTo-Json -InputObject @{ text = $text } -Compress))
    } finally {
        $bitmap.Dispose()
    }
} finally {
    $writer.Dispose()
    $stream.Dispose()
    $image.Dispose()
}
