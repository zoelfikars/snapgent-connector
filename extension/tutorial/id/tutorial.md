# Cara Pengunaan

## Prasyarat :

@gambar(1794052370313.png)

1. Snapgent MCP sudah dijalankan (.exe untuk windows, snapgent untuk linux)

@gambar(1794047217661.png, width=200)

## Quickstart

@gambar(1794052351628.png, width=200) @gambar(1794052578579.png, width=200)

Buka chat baru di provider manapun lalu klik tombol start.

Auto untuk mode tidak akan meminta permission ketika melakukan aksi.

snapgent-connector, folder kerja. lebih baik pilih folder daripada Auto.

Snapgent MCP dan Deepseek bisa diabaikan.

Terminal untuk eksekusi tool manual dan monitor output tool yang sudah/sedang dijalankan.

Bintang untuk skill (bisa tambah/import skill).

Pengaturan untuk konfigurasi dan tes.

Info untuk tutorial.

jika sudah start ada ikon chat, disitu MCP dibuat tidak akan eksekusi apapun, cocok untuk yang suka manual dan ingin lebih hemat limit dan terhindar suspend.

provider stabil, Deepseek, Claude, Meta

provider cukup z.ai (GLM), Kimi, Grok.

catatan : GLM kadang manggil tool internal (ini cukup nambah waktu kerja :D), kimi dan grok kadang overload, deepseek kadang gagal perlu continue (tapi worthit deepseek).

saran : rotasi provider tiap selesai bikin fitur, rawan suspend 3-7 hari deepseek.

## Terminal

@gambar(1794050398858.png, width=50)

membuka popup terminal, disini hasil command yang pernah dijalankan muncul untuk di monitor, bisa juga run command secara manual ataupun copy output secara manual per command yang dijalankan. untuk melihat contoh command yang bisa di run ada di Examples.

@gambar(1794049484007.png)

## File / Folder

@gambar(1794050421709.png, width=50)

membuka popup Files, file dan folder bisa dipilih/select dan diinsert ke konteks chat, tombol refresh untuk memuat ulang file/folder jika ada update dan belum sesuai file/foldernya, lalu ada checkbox Open this list... gunanya di kolom chat ai ketika mengetik @ akan muncul seperti di gambar. PENTING: ketika folder dipilih maka isi file yang ada didalam folder itu akan dikirimkan semua.

@gambar(1794049937101.png)

@gambar(1794050042742.png)

## Skill

@gambar(1794050432724.png, width=50)

@gambar(1794050252927.png, width=300)

perlu diingat skill ini nanti akan di injeksi saja bahwa ada skill yang diaktifkan didalam workspace dan ai akan bertanya apakah skill tersebut perlu digunakan atau tidak.

## MCP

@gambar(1794050380299.png, width=50)

@gambar(1794050474844.png, width=300)

belum terlalu berguna (abaikan)

## Preferences

@gambar(1794050594549.png, width=50)

@gambar(1794051092428.png, width=500) @gambar(1794050620912.png, width=500)

@gambar(1794050631972.png, width=500)

Message size, secara default sudah di set 50K, artinya per prompt dibatas hanya 50K karakter, jika lebih maka ada 2 kondisi, ketika Output as file aktif maka semua output dikirim sebagai file attach .txt (disini bahkan bisa hingga 1100K karakter atau setara 275k token/konteks, dimana itu cukup besar), saran biarkan default.

Commands per reply artinya per jawaban ai jika perlu menggunakan semua tools mcp batasnya adalah 20 tool json yang bisa di eksekusi.

Output as file jika aktif maka ketika prompt yang dihasilkan mcp melebihi Message size akan dikirim sebagai file attach .txt. (provider yang bisa menerima file diantaranya ada Deepseek, ChatGPT - terlalu cepat terkena limit upload file, Claude, Meta AI, z.ai, Kimi, dan Grok)

Only for this site jika aktif settingan akan disimpan untuk situs provider, jika tidak aktif maka akan menyimpan untuk semua situs.

Folders left out of attachments, bagian ini terkait ke File/Folder, jika folder/file ditambahkan maka tidak akan muncul di list file nya (gunanya supaya list file tidak muncul sampah dari node_modules, target, dll).

Project instruction files, bagian ini adalah file md acuan, biasanya digunakan sebagai rules dalam suatu project agar AI bisa mematuhi aturan tersebut. cara kerjanya file md akan diinjeksi di awal ketika sesi chat dimulai.

Move to the top right corner, memindahkan posisi popup menu jadi di pojok kanan atas.

Hide the bar, menyembunyikan popup (bisa juga dari ikon listrik)

@gambar(1794051319093.png, width=50)

Calibrate this site, untuk kalibrasi suatu provider (misal provider ai yang belum ada), nantinya akan disuruh memilih textfield, tombol kirim (bisa pakai enter jika tidak ada tombol kirim di textfield nya), response ai, dan chat user. sebagai tambahan beberapa provider ada yang response ai nya satu bagian dengan thinking (ini bisa dianggap tool call oleh mcp), jadi disarankan untuk memilih bagian thinking jika ketika memilih bagian response ai area thinking nya ikut terbawa.

Export calibration, ekspor file json untuk kalibrasi satu provider ai.

Copy diagnostics, untuk kebutuhan debugging, abaikan saja.

Remove calibration, menghapus hasil kalibrasi (jika dihapus perlu kalibrasi ulang manual)

Export all calibrations, ekspor file json untuk semua provider, termasuk profile dari message size sampai ke project intstructions files

Import calibrations, impor file json untuk menimpa default kalibrasi nya jika pernah konfigurasi sendiri.

sisanya hanya untuk keperluan test

## Mode Agent Off

@gambar(1794051654540.png, width=50)

Bagian ini mcp tidak akan membaca output yang ai berikan, cocok jika ingin secara manual menjalankan perintahnya via terminal secara manual. dan mengirim outputnya sesuai kebutuhan (ini bisa menghemat limit dan menghindari bot/suspend karena jika otomatis proses nya terlalu cepat).

## Tombol Aksi

@gambar(1794051849382.png, width=50) @gambar(1794051874950.png, width=50)

Tombol Play, bisa digunakan ketika kamu menghentikan proses yang sedang berjalan. misalnya mcp sedang eksekusi 3 perintah, pada proses 1/3 kamu tekan tombol stop kuning. maka bisa dilanjut oleh tombol play.

## Dropdown Auto

@gambar(1794051992617.png, width=300)

@gambar(1794052201818.png, width=200) @gambar(1794052027483.png, width=200)

ada 3 mode Plan, Auto atau Manual. plan hanya boleh baca file mcp pasti menolak edit, Auto tanpa approval pengguna dan Manual tiap melakukan aksi selalu minta approval.

## Dropdown Workspace

@gambar(1794052000319.png, width=300)

@gambar(1794052210359.png, width=200) @gambar(1794052008606.png, width=200)

merupakan folder/workspace kerja yang dipilih. secara default Auto yaitu dengan mengambil dari kode editor vscode, antigravity, codex yang basenya vscode. disarankan pilih folder secara manual sebelum memulai sesi chat baru.

## Dropdown MCP

@gambar(1794052137314.png, width=300)

@gambar(1794052217143.png, width=200) @gambar(1794052144153.png, width=200)

tidak terlalu penting, secara default memilih mcp yang sudah dijalankan di Prasyarat 1.

## Dropdown Provider

@gambar(1794052158468.png, width=300)

@gambar(1794052220202.png, width=200) @gambar(1794052232818.png, width=200)

provider AI yang aktif di halaman yang sedang dibuka. jika dipilih nanti akan membuka tab baru. untuk shortcut saja.
