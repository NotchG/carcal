@echo off
rem carcal DSP bridge - run on the Windows laptop connected to the DSP.
rem First time only:  pip install -e .[bridge,gui]
rem Keep the Rainbow app open (not minimised) and connected to the amp.
rem Windows will ask to allow Python on the network: allow it on Private networks.
cd /d "%~dp0"
python -m carcal.bridge
pause
