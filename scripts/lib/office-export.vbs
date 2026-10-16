' Export an Office document to PDF using the application's own rendering engine.
'
' Why VBScript instead of PowerShell:
'   PowerShell (both 5.1 and 7) loads the Office Primary Interop Assembly for
'   typed COM access. On this machine that assembly is broken and every
'   interface query fails with TYPE_E_CANTLOADLIBRARY (0x80029C4A), so
'   $app.Presentations comes back NULL. VBScript uses pure IDispatch
'   late binding and never touches the PIA, which sidesteps the problem.
'
' Usage:
'   cscript //nologo office-export.vbs <kind> <src> <out>
'     kind: pptx | docx | xlsx
'
' Exit code 0 on success. The caller checks that the output file exists.

Option Explicit

Dim kind, src, outPath, app, doc, fso

If WScript.Arguments.Count < 3 Then
  WScript.Echo "ERR usage: office-export.vbs <kind> <src> <out>"
  WScript.Quit 1
End If

kind = LCase(WScript.Arguments(0))
src = WScript.Arguments(1)
outPath = WScript.Arguments(2)

Set fso = CreateObject("Scripting.FileSystemObject")

On Error Resume Next

If kind = "pptx" Then
  Set app = CreateObject("PowerPoint.Application")
  If Err.Number <> 0 Then
    WScript.Echo "ERR create PowerPoint failed: " & Err.Description
    WScript.Quit 1
  End If
  ' Open(FileName, ReadOnly, Untitled, WithWindow)
  Set doc = app.Presentations.Open(src, True, False, False)
  If Err.Number <> 0 Then
    WScript.Echo "ERR open failed: " & Err.Description
    app.Quit
    WScript.Quit 1
  End If
  ' 32 = ppSaveAsPDF
  doc.SaveAs outPath, 32
  If Err.Number <> 0 Then
    WScript.Echo "ERR SaveAs failed: " & Err.Description
    doc.Close
    app.Quit
    WScript.Quit 1
  End If
  doc.Close
  app.Quit

ElseIf kind = "docx" Then
  Set app = CreateObject("Word.Application")
  app.Visible = False
  app.DisplayAlerts = 0
  Set doc = app.Documents.Open(src, False, True, False)
  If Err.Number <> 0 Then
    WScript.Echo "ERR open failed: " & Err.Description
    app.Quit
    WScript.Quit 1
  End If
  ' 17 = wdExportFormatPDF
  doc.SaveAs outPath, 17
  If Err.Number <> 0 Then
    WScript.Echo "ERR SaveAs failed: " & Err.Description
    doc.Close False
    app.Quit
    WScript.Quit 1
  End If
  doc.Close False
  app.Quit

ElseIf kind = "xlsx" Then
  Set app = CreateObject("Excel.Application")
  app.Visible = False
  app.DisplayAlerts = False
  Set doc = app.Workbooks.Open(src, 0, True)
  If Err.Number <> 0 Then
    WScript.Echo "ERR open failed: " & Err.Description
    app.Quit
    WScript.Quit 1
  End If
  ' 0 = xlTypePDF
  doc.ExportAsFixedFormat 0, outPath
  If Err.Number <> 0 Then
    WScript.Echo "ERR export failed: " & Err.Description
    doc.Close False
    app.Quit
    WScript.Quit 1
  End If
  doc.Close False
  app.Quit

Else
  WScript.Echo "ERR unknown kind: " & kind
  WScript.Quit 1
End If

On Error GoTo 0

If fso.FileExists(outPath) Then
  WScript.Echo "OK " & fso.GetFile(outPath).Size
  WScript.Quit 0
Else
  WScript.Echo "ERR output file was not created"
  WScript.Quit 1
End If
