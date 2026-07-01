# DevCortex terminal demo — render to demo/demo.gif with VHS:
#   brew install vhs        # https://github.com/charmbracelet/vhs
#   vhs demo/demo.tape
#
# It runs the real demo/demo.sh (no mocks) and captures the actual ship gate
# flipping from NOT_READY to READY.

Output demo/demo.gif

Set Shell bash
Set FontSize 15
Set Width 1120
Set Height 860
Set Theme "Dracula"
Set Padding 22
Set TypingSpeed 45ms

Sleep 600ms
Type "DEMO_PAUSE=1.3 bash demo/demo.sh"
Sleep 400ms
Enter
Sleep 12s
