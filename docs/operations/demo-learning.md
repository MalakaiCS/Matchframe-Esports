# Demo learning: pro demos to POV data on your storage

Matchframe reads CS2 demos on this computer, keeps what matters for choosing POVs, uploads it to your FTP storage, and deletes the demo. Everything is in **Demo Library**.

## Once

1. **Python for reading demos → Set up Python.** Matchframe finds Python 3.11 or newer on the computer and installs the pipeline's packages into its own folder (`<data folder>/python-env`), not into your Python. It takes a few minutes and needs the internet. No Python yet? Install it from [python.org](https://www.python.org/downloads/) (tick **Add python.exe to PATH**) and press Set up again. **Check** lists the packages.
2. **Cloud storage (FTP)**:
   1. Enter the server address, port (21), user name, password, and a folder (`/matchframe`).
   2. **Connection:** keep **Encrypted (FTPS)** if the server offers it. **Unencrypted FTP** sends the password and the data readable over the internet.
   3. Press **Save and test connection**. Matchframe logs in, writes a test file, checks its size and deletes it. With FTPS, the server's certificate is trusted at this first good test and checked on every connection after it. If it ever changes, uploads stop until you press **Forget certificate** and test again.
   4. Tick **Upload datasets automatically**.
   5. Tick **Delete each demo once its data is uploaded** to remove demos after the upload is checked. They wait in quarantine first, for the quarantine days in Library settings (7 by default; 0 deletes at once).
3. The password is stored encrypted on this computer, never shown again, and never sent on a command line. Change it on the server if it was ever shared in plain text.

## Each time

Drop demos into the ingest folder (`<data folder>/demo-ingest`): `.dem` files, or HLTV's `.zip` / `.rar` as downloaded. Or import a folder with **Import demos**.

1. **Archives:** the demos are taken out into `demo-ingest/unpacked/<archive>/`, and an archive in the ingest folder is then deleted. `.rar` uses Windows' own `tar` (RAR5 needs Windows 11). If an archive can't be opened, a note says so: take the `.dem` files out with File Explorer or 7-Zip.
2. **Reading:** each demo is read, checked and kept as a dataset. This covers rounds, kills and damage, every player's position, view and health 16 times a second, and grenades. It is paused while a broadcast is live.
3. **POV labels:** for every moment and player, whether they get a kill, die, or start a multi-frag in the next 2, 5 or 10 seconds. This is which POV a perfect observer would have been on.
4. **Upload:** the dataset (20–40 MB a match) goes to `<folder>/datasets/map=…/build=…/demo=…/` on the storage. Every file's size is checked, and the folder only appears once it is complete. One upload runs at a time, never during a live broadcast. After a failure (server down, wrong password) the next try is 10 minutes later. The card shows the last error.
5. **Delete:** if chosen, the demo is deleted after its quarantine, but only once its upload is recorded.

The datasets also stay on this computer (for training here). The storage holds the copy that survives.
