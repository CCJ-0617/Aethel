Output docs/setup.gif
Set Shell "bash"
Set FontSize 16
Set Width 900
Set Height 500
Set Padding 40
Set Theme "Dracula"
Set Framerate 30


Hide
Type 'alias aethel="node scripts/mock-setup.js"'
Enter
Type 'clear'
Enter
Show

Type "aethel auth"
Enter
Sleep 3s

Type 'aethel init --local-path ./my-drive      # sync entire My Drive'
Enter
Sleep 2s

Type 'aethel pull --all -m "initial pull"      # hydrate local files from Drive'
Enter
Sleep 6s
