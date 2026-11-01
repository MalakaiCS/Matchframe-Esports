# Matchframe Team Comms: TeamSpeak 3 client plugin (docs/operations/team-comms.md).
#   node scripts/fetch-sdk.mjs                       # the SDK headers, into .sdk/
#   cmake -S . -B build -DCMAKE_BUILD_TYPE=Release   # Linux (gcc), or -A x64 with MSVC on Windows
#   cmake --build build --config Release
# Windows from Linux: -DCMAKE_TOOLCHAIN_FILE=cmake/mingw-w64.cmake
cmake_minimum_required(VERSION 3.16)
project(matchframe_comms VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(TS3_SDK_INCLUDE "${CMAKE_CURRENT_SOURCE_DIR}/.sdk/include" CACHE PATH "TeamSpeak 3 plugin SDK include folder (scripts/fetch-sdk.mjs)")
if(NOT EXISTS "${TS3_SDK_INCLUDE}/ts3_functions.h")
  message(FATAL_ERROR "TeamSpeak plugin SDK headers not found in ${TS3_SDK_INCLUDE}: run node scripts/fetch-sdk.mjs first")
endif()

# TeamSpeak's own plugin naming: <name>_win64.dll, <name>_linux_amd64.so, <name>_mac.dylib.
if(WIN32)
  set(MF_SUFFIX "_win64")
elseif(APPLE)
  set(MF_SUFFIX "_mac")
else()
  set(MF_SUFFIX "_linux_amd64")
endif()

add_library(matchframe_comms SHARED src/plugin.cpp)
set_target_properties(matchframe_comms PROPERTIES OUTPUT_NAME "matchframe_comms${MF_SUFFIX}" PREFIX "")
target_include_directories(matchframe_comms PRIVATE "${TS3_SDK_INCLUDE}" src)
target_compile_definitions(matchframe_comms PRIVATE MF_PLUGIN_VERSION="${PROJECT_VERSION}")

if(MSVC)
  # Static runtime: no Visual C++ redistributable needed next to TeamSpeak.
  set_property(TARGET matchframe_comms PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded")
  target_compile_options(matchframe_comms PRIVATE /W4 /permissive- /utf-8)
  target_link_libraries(matchframe_comms PRIVATE ws2_32)
elseif(WIN32)
  # mingw-w64: everything static, so the DLL needs only Windows' own libraries.
  target_compile_options(matchframe_comms PRIVATE -Wall -Wextra -O2)
  target_link_options(matchframe_comms PRIVATE -static -static-libgcc -static-libstdc++)
  target_link_libraries(matchframe_comms PRIVATE ws2_32)
else()
  target_compile_options(matchframe_comms PRIVATE -Wall -Wextra -O2)
  find_package(Threads REQUIRED)
  target_link_libraries(matchframe_comms PRIVATE Threads::Threads)
  if(NOT APPLE)
    target_link_options(matchframe_comms PRIVATE -static-libstdc++ -static-libgcc -Wl,--no-undefined)
  endif()
endif()
